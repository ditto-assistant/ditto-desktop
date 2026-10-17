// DITTO: OmniSynth integration — talks to the OmniSynth DAW's loopback bridge.
import {
  OMNISYNTH_BRIDGE_PROTOCOL,
  OmniSynthBridgeInfo,
  OmniSynthRequestError,
  OmniSynthUnavailableError,
  type OmniSynthGenerateResult,
  type OmniSynthToolSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "../processRunner.ts";

/**
 * OmniSynth writes `bridge.json` {port, token, pid, …} to its app-support
 * directory while it runs and removes it on quit. Reading that file is the
 * whole discovery protocol: no port scanning, no registry, and the token in
 * it is the only credential. A stale file (app crashed) is detected by
 * /health failing and treated as "installed, not running".
 */

export interface OmniSynthStatusShape {
  readonly installed: boolean;
  readonly running: boolean;
  readonly version?: string;
  readonly appPath?: string;
  readonly song?: unknown;
  readonly tools: ReadonlyArray<OmniSynthToolSummary>;
}

export interface OmniSynthServiceShape {
  readonly status: (input: {
    readonly includeTools: boolean;
  }) => Effect.Effect<OmniSynthStatusShape, OmniSynthUnavailableError | OmniSynthRequestError>;
  readonly state: Effect.Effect<unknown, OmniSynthUnavailableError | OmniSynthRequestError>;
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<string, OmniSynthUnavailableError | OmniSynthRequestError>;
  readonly generate: (input: {
    readonly prompt: string;
    readonly attachments: ReadonlyArray<string>;
    readonly mode: "new" | "iterate";
    readonly source: string;
  }) => Effect.Effect<OmniSynthGenerateResult, OmniSynthUnavailableError | OmniSynthRequestError>;
  readonly launch: (
    prompt: string | undefined,
  ) => Effect.Effect<OmniSynthStatusShape, OmniSynthUnavailableError | OmniSynthRequestError>;
}

export class OmniSynthService extends Context.Service<OmniSynthService, OmniSynthServiceShape>()(
  "t3/omnisynth/OmniSynthService",
) {}

const decodeBridgeInfo = Schema.decodeUnknownEffect(Schema.fromJsonString(OmniSynthBridgeInfo));
const decodeJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJsonUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Where OmniSynth keeps bridge.json on each platform (mirrors electron/bridge.ts in omnisynth). */
export function omniSynthDiscoveryPath(
  path: Path.Path,
  platform: string,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "darwin")
    return path.join(home, "Library", "Application Support", "OmniSynth", "bridge.json");
  if (platform === "win32")
    return path.join(
      env.APPDATA ?? path.join(home, "AppData", "Roaming"),
      "OmniSynth",
      "bridge.json",
    );
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "omnisynth", "bridge.json");
}

/** App bundles / executables to try when launching. */
export function omniSynthAppCandidates(
  path: Path.Path,
  platform: string,
  env: NodeJS.ProcessEnv,
  home: string,
): ReadonlyArray<string> {
  if (platform === "darwin")
    return ["/Applications/OmniSynth.app", path.join(home, "Applications", "OmniSynth.app")];
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(local, "Programs", "OmniSynth", "OmniSynth.exe")];
  }
  return [
    "/usr/bin/omnisynth",
    "/opt/OmniSynth/omnisynth",
    path.join(home, ".local", "bin", "omnisynth"),
  ];
}

const GENERATE_TIMEOUT = Duration.minutes(15);
const TOOL_TIMEOUT = Duration.seconds(60);
const PROBE_TIMEOUT = Duration.seconds(3);
const LAUNCH_WAIT = Duration.seconds(12);

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const platform = yield* HostProcessPlatform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const env = process.env;
  const home = env.HOME ?? env.USERPROFILE ?? "";
  const discoveryPath = omniSynthDiscoveryPath(path, platform, env, home);
  const appCandidates = omniSynthAppCandidates(path, platform, env, home);

  const readInfo = fileSystem.readFileString(discoveryPath).pipe(
    Effect.flatMap((text) => decodeBridgeInfo(text)),
    Effect.option,
  );

  const installedAppPath = Effect.gen(function* () {
    for (const candidate of appCandidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
        return candidate;
    }
    return undefined;
  });

  const unavailable = (installed: boolean, appPath?: string) =>
    new OmniSynthUnavailableError({
      installed,
      reason: installed
        ? `OmniSynth is installed${appPath ? ` at ${appPath}` : ""} but not running. Call omnisynth_launch or ask the user to open it.`
        : "OmniSynth is not installed on this machine (https://github.com/omniaura/omnisynth).",
    });

  const requestFailed = (operation: string) => (cause: unknown) =>
    new OmniSynthRequestError({
      operation,
      reason: cause instanceof Error ? cause.message : String(cause),
    });

  /** JSON request to the bridge with the discovery token; `timeout` bounds the whole call. */
  const request = Effect.fn("OmniSynthService.request")(function* <A>(
    info: OmniSynthBridgeInfo,
    method: "GET" | "POST",
    route: string,
    body: unknown,
    timeout: Duration.Duration,
  ) {
    const url = `http://127.0.0.1:${info.port}${route}`;
    const base = method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url);
    const withBody =
      body === undefined
        ? Effect.succeed(base)
        : HttpClientRequest.bodyJson(base, body).pipe(Effect.mapError(requestFailed(route)));
    const req = (yield* withBody).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${info.token}`),
    );
    const response = yield* httpClient
      .execute(req)
      .pipe(Effect.timeout(timeout), Effect.mapError(requestFailed(route)));
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const json: unknown =
      text.length === 0
        ? {}
        : yield* decodeJsonUnknown(text).pipe(
            Effect.orElseSucceed(() => ({ error: text.slice(0, 200) })),
          );
    if (response.status >= 400) {
      const message =
        typeof json === "object" && json !== null && "error" in json
          ? String((json as { error: unknown }).error)
          : `HTTP ${response.status}`;
      return yield* new OmniSynthRequestError({ operation: route, reason: message });
    }
    return json as A;
  });

  /** The live bridge, or the reason it is not available. A stale discovery file is "installed, not running". */
  const live = Effect.gen(function* () {
    const info = yield* readInfo;
    if (Option.isNone(info) || info.value.protocol !== OMNISYNTH_BRIDGE_PROTOCOL) {
      const appPath = yield* installedAppPath;
      return yield* unavailable(appPath !== undefined || Option.isSome(info), appPath);
    }
    const health = yield* request<{ ok?: boolean; version?: string; song?: unknown }>(
      info.value,
      "GET",
      "/health",
      undefined,
      PROBE_TIMEOUT,
    ).pipe(Effect.option);
    if (Option.isNone(health) || health.value.ok !== true) {
      const appPath = yield* installedAppPath;
      return yield* unavailable(true, appPath ?? info.value.appPath);
    }
    return { info: info.value, health: health.value };
  });

  const status: OmniSynthServiceShape["status"] = Effect.fn("OmniSynthService.status")(
    function* (input) {
      const result = yield* live.pipe(Effect.option);
      if (Option.isNone(result)) {
        const appPath = yield* installedAppPath;
        const info = yield* readInfo;
        const knownPath = appPath ?? Option.getOrUndefined(info)?.appPath;
        const closed: OmniSynthStatusShape = {
          installed: appPath !== undefined || Option.isSome(info),
          running: false,
          tools: [],
          ...(knownPath === undefined ? {} : { appPath: knownPath }),
        };
        return closed;
      }
      const { info, health } = result.value;
      const tools: ReadonlyArray<OmniSynthToolSummary> = input.includeTools
        ? yield* request<ReadonlyArray<{ name: string; description: string }>>(
            info,
            "GET",
            "/tools",
            undefined,
            PROBE_TIMEOUT,
          ).pipe(
            Effect.map((list) => list.map(({ name, description }) => ({ name, description }))),
            Effect.orElseSucceed(() => [] as ReadonlyArray<OmniSynthToolSummary>),
          )
        : [];
      const open: OmniSynthStatusShape = {
        installed: true,
        running: true,
        version: health.version ?? info.version,
        appPath: info.appPath,
        tools,
        ...(health.song === undefined ? {} : { song: health.song }),
      };
      return open;
    },
  );

  const state: OmniSynthServiceShape["state"] = Effect.gen(function* () {
    const { info } = yield* live;
    return yield* request<unknown>(info, "GET", "/state", undefined, PROBE_TIMEOUT);
  }).pipe(Effect.withSpan("OmniSynthService.state"));

  const callTool: OmniSynthServiceShape["callTool"] = Effect.fn("OmniSynthService.callTool")(
    function* (name, args) {
      const { info } = yield* live;
      const out = yield* request<{ ok: boolean; result?: unknown; error?: string }>(
        info,
        "POST",
        `/tools/${encodeURIComponent(name)}`,
        args,
        TOOL_TIMEOUT,
      );
      if (!out.ok)
        return yield* new OmniSynthRequestError({
          operation: name,
          reason: out.error ?? "tool failed",
        });
      return typeof out.result === "string" ? out.result : encodeJsonUnknown(out.result);
    },
  );

  const generate: OmniSynthServiceShape["generate"] = Effect.fn("OmniSynthService.generate")(
    function* (input) {
      const { info } = yield* live;
      const out = yield* request<{
        ok: boolean;
        summary?: string;
        state?: unknown;
        error?: string;
      }>(
        info,
        "POST",
        "/generate",
        {
          prompt: input.prompt,
          attachments: input.attachments.map((p) => ({ path: p })),
          mode: input.mode,
          source: input.source,
          wait: true,
        },
        GENERATE_TIMEOUT,
      );
      if (!out.ok)
        return yield* new OmniSynthRequestError({
          operation: "generate",
          reason: out.error ?? "generation failed",
        });
      return { summary: out.summary ?? "Done.", state: out.state ?? null };
    },
  );

  const launch: OmniSynthServiceShape["launch"] = Effect.fn("OmniSynthService.launch")(
    function* (prompt) {
      const already = yield* live.pipe(Effect.option);
      if (Option.isSome(already) && prompt === undefined)
        return yield* status({ includeTools: true });
      const appPath = yield* installedAppPath;
      if (!appPath) return yield* unavailable(false);
      const url =
        prompt === undefined
          ? undefined
          : `omnisynth://generate?prompt=${encodeURIComponent(prompt)}&source=ditto-desktop`;
      // Open through the OS so the app's single-instance lock and protocol handler do the routing.
      const command =
        platform === "darwin"
          ? { file: "/usr/bin/open", args: url ? ["-a", appPath, url] : [appPath] }
          : platform === "win32"
            ? { file: "cmd", args: ["/c", "start", "", url ?? appPath] }
            : { file: "xdg-open", args: [url ?? appPath] };
      yield* runner
        .run({ command: command.file, args: command.args, timeout: Duration.seconds(10) })
        .pipe(Effect.mapError(requestFailed("launch")), Effect.ignore);
      // Wait for the bridge to come up.
      const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(LAUNCH_WAIT);
      while ((yield* Clock.currentTimeMillis) < deadline) {
        const probe = yield* live.pipe(Effect.option);
        if (Option.isSome(probe)) break;
        yield* Effect.sleep(Duration.millis(500));
      }
      return yield* status({ includeTools: true });
    },
  );

  return OmniSynthService.of({ status, state, callTool, generate, launch });
});

export const layer = Layer.effect(OmniSynthService, make);
