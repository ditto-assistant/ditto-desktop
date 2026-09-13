/**
 * Environment tunnels: the backend relays a paired host's bytes to this
 * server's local RPC listener (`env.open` / `env.frame` / `env.close`). The
 * target is a service so tests can stand in for the local WebSocket.
 *
 * @module remote/HostBridgeTunnel
 */
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

export class HostBridgeTunnelError extends Schema.TaggedError<HostBridgeTunnelError>()(
  "HostBridgeTunnelError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** One connection to the local listener. `incoming` ends when the listener closes. */
export interface HostBridgeTunnelConnection {
  readonly send: (bytes: Uint8Array) => Effect.Effect<void, HostBridgeTunnelError>;
  readonly incoming: Queue.Dequeue<Uint8Array, Cause.Done>;
  readonly close: Effect.Effect<void>;
}

export interface HostBridgeTunnelTargetShape {
  readonly connect: (input: {
    readonly path: string | undefined;
  }) => Effect.Effect<HostBridgeTunnelConnection, HostBridgeTunnelError>;
}

export class HostBridgeTunnelTarget extends Context.Service<
  HostBridgeTunnelTarget,
  HostBridgeTunnelTargetShape
>()("t3/remote/HostBridgeTunnel/HostBridgeTunnelTarget") {}

interface WebSocketLike {
  binaryType: string;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  send(data: Uint8Array | string): void;
  close(): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;

/** Connects to this server's own listener (from the persisted runtime state) over loopback. */
const makeLocalWebSocketTunnelTarget = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const WebSocketCtor = (globalThis as { WebSocket?: unknown }).WebSocket as
    | WebSocketConstructor
    | undefined;
  return {
    connect: ({ path }) =>
      Effect.gen(function* () {
        if (WebSocketCtor === undefined) {
          return yield* new HostBridgeTunnelError({ detail: "WebSocket is not available." });
        }
        const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new HostBridgeTunnelError({ detail: "Could not read the server listener.", cause }),
          ),
        );
        if (Option.isNone(state)) {
          return yield* new HostBridgeTunnelError({
            detail: "The server has not published a listener.",
          });
        }
        const url = `ws://127.0.0.1:${String(state.value.port)}${path ?? "/ws"}`;
        const incoming = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const socket = yield* Effect.callback<WebSocketLike, HostBridgeTunnelError>((resume) => {
          let ws: WebSocketLike;
          try {
            ws = new WebSocketCtor(url);
            ws.binaryType = "arraybuffer";
          } catch (cause) {
            resume(
              Effect.fail(new HostBridgeTunnelError({ detail: `Failed to open ${url}.`, cause })),
            );
            return;
          }
          let settled = false;
          ws.addEventListener("open", () => {
            settled = true;
            resume(Effect.succeed(ws));
          });
          ws.addEventListener("error", (event) => {
            if (settled) return;
            settled = true;
            resume(
              Effect.fail(
                new HostBridgeTunnelError({ detail: `Failed to connect to ${url}.`, cause: event }),
              ),
            );
          });
        });
        socket.addEventListener("message", (event) => {
          const bytes =
            event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : new TextEncoder().encode(
                  typeof event.data === "string" ? event.data : String(event.data),
                );
          void Effect.runPromise(Queue.offer(incoming, bytes));
        });
        socket.addEventListener("close", () => {
          void Effect.runPromise(Queue.end(incoming));
        });
        return {
          incoming,
          send: (bytes) =>
            Effect.try({
              try: () => socket.send(bytes),
              catch: (cause) => new HostBridgeTunnelError({ detail: "Tunnel send failed.", cause }),
            }),
          close: Effect.sync(() => socket.close()),
        } satisfies HostBridgeTunnelConnection;
      }),
  } satisfies HostBridgeTunnelTargetShape;
});

export const layer = Layer.effect(HostBridgeTunnelTarget, makeLocalWebSocketTunnelTarget);
