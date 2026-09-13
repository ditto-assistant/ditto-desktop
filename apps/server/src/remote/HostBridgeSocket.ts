/**
 * The socket the host bridge client talks through. A factory service so tests
 * can hand the client an in-memory stub backend instead of a real WebSocket.
 *
 * @module remote/HostBridgeSocket
 */
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

export class HostBridgeSocketError extends Schema.TaggedError<HostBridgeSocketError>()(
  "HostBridgeSocketError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** One open connection. `incoming` ends (`Queue.end`) when the peer closes. */
export interface HostBridgeSocket {
  readonly send: (text: string) => Effect.Effect<void, HostBridgeSocketError>;
  readonly incoming: Queue.Dequeue<string, Cause.Done>;
  readonly close: Effect.Effect<void>;
}

export interface HostBridgeSocketFactoryShape {
  readonly connect: (input: {
    readonly url: string;
    readonly bearerToken: string;
  }) => Effect.Effect<HostBridgeSocket, HostBridgeSocketError>;
}

export class HostBridgeSocketFactory extends Context.Service<
  HostBridgeSocketFactory,
  HostBridgeSocketFactoryShape
>()("t3/remote/HostBridgeSocket/HostBridgeSocketFactory") {}

interface WebSocketLike {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

type WebSocketConstructor = new (
  url: string,
  options?: { readonly headers?: Record<string, string> },
) => WebSocketLike;

function resolveWebSocketConstructor(): WebSocketConstructor | null {
  const candidate = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof candidate === "function" ? (candidate as WebSocketConstructor) : null;
}

/**
 * Node/Bun global `WebSocket` (undici accepts `headers` in the options bag).
 * The bearer also rides along as the `ditto-host` subprotocol-free query for
 * runtimes that drop custom headers.
 */
const makeWebSocketHostBridgeSocketFactory = (
  WebSocketCtor: WebSocketConstructor | null = resolveWebSocketConstructor(),
): HostBridgeSocketFactoryShape => ({
  connect: ({ url, bearerToken }) =>
    Effect.gen(function* () {
      if (WebSocketCtor === null) {
        return yield* new HostBridgeSocketError({ detail: "WebSocket is not available." });
      }
      const incoming = yield* Queue.unbounded<string, Cause.Done>();
      const socket = yield* Effect.callback<WebSocketLike, HostBridgeSocketError>((resume) => {
        let ws: WebSocketLike;
        try {
          ws = new WebSocketCtor(url, { headers: { Authorization: `Bearer ${bearerToken}` } });
        } catch (cause) {
          resume(
            Effect.fail(new HostBridgeSocketError({ detail: `Failed to open ${url}.`, cause })),
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
              new HostBridgeSocketError({ detail: `Failed to connect to ${url}.`, cause: event }),
            ),
          );
        });
      });
      socket.addEventListener("message", (event) => {
        const text =
          typeof event.data === "string"
            ? event.data
            : event.data instanceof ArrayBuffer
              ? new TextDecoder().decode(event.data)
              : String(event.data);
        void Effect.runPromise(Queue.offer(incoming, text));
      });
      socket.addEventListener("close", () => {
        void Effect.runPromise(Queue.end(incoming));
      });
      return {
        incoming,
        send: (text) =>
          Effect.try({
            try: () => socket.send(text),
            catch: (cause) => new HostBridgeSocketError({ detail: "Failed to send frame.", cause }),
          }),
        close: Effect.sync(() => socket.close()),
      } satisfies HostBridgeSocket;
    }),
});

export const layer = Layer.succeed(HostBridgeSocketFactory, makeWebSocketHostBridgeSocketFactory());
