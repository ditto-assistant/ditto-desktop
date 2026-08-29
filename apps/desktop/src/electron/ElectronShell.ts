import { REMOTE_CAPABLE_EDITOR_IDS, remoteSchemeForEditor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

// Remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`)
// must reach the OS handler; every other non-web scheme stays blocked.
const SAFE_WEB_PROTOCOLS = new Set(["http:", "https:"]);
const REMOTE_EDITOR_PROTOCOLS = new Set(
  REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
    const scheme = remoteSchemeForEditor(id);
    return scheme === undefined ? [] : [`${scheme}:`];
  }),
);

const isRemoteEditorUrl = (url: URL) =>
  REMOTE_EDITOR_PROTOCOLS.has(url.protocol) &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.host === "vscode-remote" &&
  url.pathname.startsWith("/ssh-remote+") &&
  url.pathname.length > "/ssh-remote+".length;

const DISCORD_ID = /^\d+$/;

const isDiscordConversationUrl = (url: URL) => {
  if (
    url.protocol !== "discord:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.host !== "-" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return false;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  return (
    parts.length === 3 &&
    parts[0] === "channels" &&
    (parts[1] === "@me" || DISCORD_ID.test(parts[1] ?? "")) &&
    DISCORD_ID.test(parts[2] ?? "")
  );
};

const TELEGRAM_USERNAME = /^[A-Za-z0-9_]{5,32}$/;

const isTelegramConversationUrl = (url: URL) =>
  url.protocol === "tg:" &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.host === "resolve" &&
  (url.pathname === "" || url.pathname === "/") &&
  url.hash.length === 0 &&
  [...url.searchParams.keys()].every((key) => key === "domain") &&
  TELEGRAM_USERNAME.test(url.searchParams.get("domain") ?? "");

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_WEB_PROTOCOLS.has(url.protocol) ||
      isRemoteEditorUrl(url) ||
      isDiscordConversationUrl(url) ||
      isTelegramConversationUrl(url)
      ? Option.some(url.href)
      : Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
