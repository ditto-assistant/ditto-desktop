/**
 * Starts host mode when a device-link key is configured: the desktop server
 * becomes a Ditto host of kind `desktop` and keeps one socket to the backend
 * for as long as it runs.
 *
 * @module remote/HostBridge.layer
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../serverActivation.ts";
import * as HostBridgeAttachments from "./HostBridgeAttachments.ts";
import { makeHostBridgeClient } from "./HostBridgeClient.ts";
import * as HostBridgeConfig from "./HostBridgeConfig.ts";
import * as HostBridgeSocket from "./HostBridgeSocket.ts";
import * as HostBridgeTunnel from "./HostBridgeTunnel.ts";
import * as OrchestrationHostBridgeRuntime from "./OrchestrationHostBridgeRuntime.ts";

const start = Effect.gen(function* () {
  const config = yield* HostBridgeConfig.HostBridgeConfig;
  if (!config.enabled) {
    yield* Effect.logInfo(
      "ditto host mode off (no DITTO_DEVICE_LINK_KEY or DITTO_REMOTE_CONTROL=0)",
    );
    return;
  }
  const client = yield* makeHostBridgeClient();
  yield* Effect.logInfo("ditto host mode starting", { url: config.socketUrl });
  yield* forkParked(client.run);
});

export const HostBridgeLive = (input: Parameters<typeof HostBridgeConfig.layer>[0]) =>
  Layer.effectDiscard(start).pipe(
    Layer.provide(
      Layer.mergeAll(
        HostBridgeConfig.layer(input),
        HostBridgeSocket.layer,
        HostBridgeAttachments.fetchLayer,
        HostBridgeTunnel.layer,
        OrchestrationHostBridgeRuntime.layer,
      ),
    ),
  );
