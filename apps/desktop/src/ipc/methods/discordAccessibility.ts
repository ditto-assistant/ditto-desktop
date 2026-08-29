import {
  DiscordAccessibilityReplyInput,
  DiscordAccessibilityReplyResult,
  DiscordAccessibilityStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import {
  DiscordAccessibilityTransport,
  NativeDiscordAccessibilityHelper,
} from "../../discord/DiscordAccessibilityTransport.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

let cachedTransport:
  | { readonly key: string; readonly transport: DiscordAccessibilityTransport }
  | undefined;

function resolveTransport(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DiscordAccessibilityTransport {
  const helperPath = environment.isPackaged
    ? environment.path.join(environment.resourcesPath, "discord-accessibility", "ditto-discord-ax")
    : environment.path.join(environment.rootDir, "apps", "desktop", ".native", "ditto-discord-ax");
  const key = `${environment.platform}:${helperPath}`;
  if (cachedTransport?.key === key) return cachedTransport.transport;
  const transport = new DiscordAccessibilityTransport(
    environment.platform,
    new NativeDiscordAccessibilityHelper(helperPath),
  );
  cachedTransport = { key, transport };
  return transport;
}

export const discordAccessibilityStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCORD_ACCESSIBILITY_STATUS_CHANNEL,
  payload: Schema.Boolean,
  result: DiscordAccessibilityStatus,
  handler: Effect.fn("desktop.ipc.discordAccessibility.status")(function* (prompt) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() => resolveTransport(environment).status(prompt));
  }),
});

export const discordAccessibilityExecute = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCORD_ACCESSIBILITY_EXECUTE_CHANNEL,
  payload: DiscordAccessibilityReplyInput,
  result: DiscordAccessibilityReplyResult,
  handler: Effect.fn("desktop.ipc.discordAccessibility.execute")(function* (input) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() => resolveTransport(environment).execute(input));
  }),
});

export const discordAccessibilityCancel = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DISCORD_ACCESSIBILITY_CANCEL_CHANNEL,
  payload: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128)),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.discordAccessibility.cancel")(function* (actionId) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return resolveTransport(environment).cancel(actionId);
  }),
});
