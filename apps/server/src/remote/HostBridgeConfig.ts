/**
 * Host-mode configuration: which Ditto backend to reach and the device-link
 * key that identifies this machine as a host of kind `desktop`.
 *
 * Host mode is on whenever a device-link key is present, matching the CLI's
 * "remote control by default" (`DITTO_REMOTE_CONTROL=0` opts out).
 *
 * @module remote/HostBridgeConfig
 */
import { HOST_BRIDGE_PATH } from "@t3tools/contracts";
import {
  HostProcessEnvironment,
  HostProcessHostname,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface HostBridgeConfigShape {
  readonly enabled: boolean;
  /** `https://api.heyditto.ai` by default; the socket path is derived from it. */
  readonly apiBaseUrl: string;
  readonly socketUrl: string;
  readonly deviceLinkKey: string;
  readonly hostName: string;
  readonly platform: string;
  readonly version: string;
}

export class HostBridgeConfig extends Context.Service<HostBridgeConfig, HostBridgeConfigShape>()(
  "t3/remote/HostBridgeConfig",
) {}

const DITTO_DEFAULT_API_BASE_URL = "https://api.heyditto.ai";

export function hostBridgeSocketUrl(apiBaseUrl: string): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return `${base.replace(/^http/, "ws")}${HOST_BRIDGE_PATH}`;
}

export function resolveHostBridgeConfig(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hostName: string;
  readonly platform: string;
  readonly version: string;
}): HostBridgeConfigShape {
  const deviceLinkKey = input.env.DITTO_DEVICE_LINK_KEY?.trim() ?? "";
  const apiBaseUrl = input.env.DITTO_API_URL?.trim() || DITTO_DEFAULT_API_BASE_URL;
  const optedOut = input.env.DITTO_REMOTE_CONTROL?.trim() === "0";
  return {
    enabled: deviceLinkKey.length > 0 && !optedOut,
    apiBaseUrl,
    socketUrl: hostBridgeSocketUrl(apiBaseUrl),
    deviceLinkKey,
    hostName: input.hostName,
    platform: input.platform,
    version: input.version,
  };
}

/** Reads the host identity from the process references so tests can inject their own. */
export const layer = (input: { readonly version: string }) =>
  Layer.effect(
    HostBridgeConfig,
    Effect.gen(function* () {
      const env = yield* HostProcessEnvironment;
      const hostName = yield* HostProcessHostname;
      const platform = yield* HostProcessPlatform;
      return resolveHostBridgeConfig({ env, hostName, platform, version: input.version });
    }),
  );
