/**
 * Host bridge protocol v1/v1.1 client: one socket to the Ditto backend,
 * announcing this machine's sessions and executing the backend's turn,
 * interrupt, checkpoint and prompt verbs through a `HostBridgeRuntime`.
 *
 * Connection lifecycle: hello → welcome → announce everything → serve frames
 * while pinging every `heartbeatSeconds`; three missed pongs drop the socket.
 * Every drop reconnects with exponential backoff (1 s … 30 s). Turn ids are
 * deduplicated so a redelivery is idempotent.
 *
 * @module remote/HostBridgeClient
 */
import {
  HOST_BRIDGE_MAX_MISSED_HEARTBEATS,
  decodeBackendToHostFrame,
  encodeHostToBackendFrame,
  type BackendToHostFrame,
  type HostBridgeTurnDeliverFrame,
  type HostToBackendFrame,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  buildTurnPrompt,
  downloadTurnAttachments,
  HostBridgeFetch,
} from "./HostBridgeAttachments.ts";
import { HostBridgeConfig } from "./HostBridgeConfig.ts";
import {
  HostBridgeRuntime,
  type HostBridgeRuntimeShape,
  type HostBridgeSession,
} from "./HostBridgeRuntime.ts";
import {
  HostBridgeSocketError,
  HostBridgeSocketFactory,
  type HostBridgeSocket,
} from "./HostBridgeSocket.ts";
import { HostBridgeTunnelTarget, type HostBridgeTunnelConnection } from "./HostBridgeTunnel.ts";

const WELCOME_TIMEOUT = Duration.seconds(15);
const RECONNECT_MIN = Duration.seconds(1);
const RECONNECT_MAX = Duration.seconds(30);
/** Enough to absorb a burst of redeliveries without growing forever. */
const SEEN_TURN_LIMIT = 2_000;

interface ActiveTurn {
  readonly turnId: string;
  interrupted: boolean;
}

export interface HostBridgeClientOptions {
  /** Overrides the welcome frame's heartbeat (tests). */
  readonly heartbeatOverride?: Duration.Duration | undefined;
  readonly reconnectMin?: Duration.Duration | undefined;
  readonly reconnectMax?: Duration.Duration | undefined;
}

export interface HostBridgeClient {
  /** Runs forever: connect, serve, reconnect. Interrupt to stop. */
  readonly run: Effect.Effect<never>;
  /** Resolves each time a welcome is received (tests, diagnostics). */
  readonly connections: Effect.Effect<number>;
}

export const makeHostBridgeClient = Effect.fn("makeHostBridgeClient")(function* (
  options: HostBridgeClientOptions = {},
) {
  const config = yield* HostBridgeConfig;
  const runtime = yield* HostBridgeRuntime;
  const factory = yield* HostBridgeSocketFactory;
  const fetcher = yield* HostBridgeFetch;
  const tunnelTarget = yield* HostBridgeTunnelTarget;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let welcomes = 0;

  const serveConnection = (socket: HostBridgeSocket) =>
    Effect.gen(function* () {
      const welcome = yield* Deferred.make<{ readonly heartbeatSeconds: number }>();
      const activeTurns = new Map<string, ActiveTurn>();
      const turnSessions = new Map<string, string>();
      const seenTurns = new Set<string>();
      const announced = new Map<string, HostBridgeSession>();
      const announcedCommands = new Map<string, string>();
      const pairedHostIds = new Set<string>();
      const tunnels = new Map<string, HostBridgeTunnelConnection>();
      let missedPongs = 0;

      const send = (frame: HostToBackendFrame) =>
        encodeHostToBackendFrame(frame).pipe(
          Effect.orDie,
          Effect.flatMap((text) => socket.send(text)),
          Effect.catchCause((cause) =>
            Effect.logWarning("host bridge send failed", {
              frame: frame.type,
              cause: Cause.pretty(cause),
            }),
          ),
        );

      const rememberTurn = (turnId: string) => {
        if (seenTurns.size >= SEEN_TURN_LIMIT) {
          const oldest = seenTurns.values().next().value;
          if (oldest !== undefined) seenTurns.delete(oldest);
        }
        seenTurns.add(turnId);
      };

      const announceSession = (session: HostBridgeSession) =>
        Effect.gen(function* () {
          const previous = announced.get(session.sessionId);
          announced.set(session.sessionId, session);
          if (previous === undefined) {
            yield* send({
              type: "session.announce",
              sessionId: session.sessionId,
              harness: session.harness,
              cwd: session.cwd,
              mode: session.mode,
              status: session.status,
              ...(session.title !== undefined ? { title: session.title } : {}),
            });
          } else if (previous.status !== session.status) {
            yield* send({
              type: "session.status",
              sessionId: session.sessionId,
              status: session.status,
            });
          }
          const commandsKey = session.commands
            .map((command) =>
              [
                command.name,
                command.source,
                command.headless,
                command.description ?? "",
                command.argsHint ?? "",
              ].join("\u0000"),
            )
            .join("\n");
          if (announcedCommands.get(session.sessionId) !== commandsKey) {
            announcedCommands.set(session.sessionId, commandsKey);
            yield* send({
              type: "session.commands",
              sessionId: session.sessionId,
              harness: session.harness,
              commands: session.commands,
            });
          }
          const active = activeTurns.get(session.sessionId);
          if (active !== undefined && session.status === "idle") {
            activeTurns.delete(session.sessionId);
            turnSessions.delete(active.turnId);
            yield* send({
              type: "turn.finished",
              turnId: active.turnId,
              exitCode: 0,
              ...(active.interrupted ? { interrupted: true } : {}),
            });
          }
        });

      const finishTurn = (
        turnId: string,
        outcome: {
          readonly exitCode: number;
          readonly error?: string;
          readonly unsupported?: string;
          readonly interrupted?: boolean;
        },
      ) =>
        send({
          type: "turn.finished",
          turnId,
          exitCode: outcome.exitCode,
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(outcome.unsupported !== undefined ? { unsupported: outcome.unsupported } : {}),
          ...(outcome.interrupted ? { interrupted: true } : {}),
        });

      const trackTurn = (sessionId: string, turnId: string) => {
        activeTurns.set(sessionId, { turnId, interrupted: false });
        turnSessions.set(turnId, sessionId);
      };

      const deliverTurn = (frame: HostBridgeTurnDeliverFrame) =>
        Effect.gen(function* () {
          const session = announced.get(frame.sessionId);
          if (session === undefined) {
            yield* finishTurn(frame.turnId, {
              exitCode: 1,
              error: `Unknown session ${frame.sessionId}.`,
            });
            return;
          }
          switch (frame.kind) {
            case "answer": {
              if (!frame.answer) {
                yield* finishTurn(frame.turnId, { exitCode: 1, error: "Missing answer." });
                return;
              }
              yield* runtime.answerPrompt({
                sessionId: frame.sessionId,
                promptId: frame.answer.promptId,
                value: frame.answer.value,
              });
              yield* send({ type: "turn.started", turnId: frame.turnId });
              yield* finishTurn(frame.turnId, { exitCode: 0 });
              return;
            }
            case "command": {
              if (!frame.command) {
                yield* finishTurn(frame.turnId, { exitCode: 1, error: "Missing command." });
                return;
              }
              const result = yield* runtime.submitCommand({
                sessionId: frame.sessionId,
                turnId: frame.turnId,
                name: frame.command.name,
                args: frame.command.args,
              });
              if (result.unsupported !== undefined) {
                yield* finishTurn(frame.turnId, { exitCode: 0, unsupported: result.unsupported });
                return;
              }
              trackTurn(frame.sessionId, frame.turnId);
              yield* send({ type: "turn.started", turnId: frame.turnId });
              return;
            }
            case "prompt": {
              const downloaded = yield* downloadTurnAttachments({
                cwd: session.cwd,
                turnId: frame.turnId,
                attachments: frame.attachments,
              }).pipe(Effect.provideService(HostBridgeFetch, fetcher));
              yield* runtime.submitTurn({
                sessionId: frame.sessionId,
                turnId: frame.turnId,
                text: buildTurnPrompt(
                  frame.text,
                  downloaded.map((entry) => entry.relativePath),
                ),
              });
              trackTurn(frame.sessionId, frame.turnId);
              yield* send({ type: "turn.started", turnId: frame.turnId });
              return;
            }
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("host bridge turn failed", {
              turnId: frame.turnId,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(
                finishTurn(frame.turnId, {
                  exitCode: 1,
                  error:
                    Cause.squash(cause) instanceof Error
                      ? (Cause.squash(cause) as Error).message
                      : "Turn failed.",
                }),
              ),
            ),
          ),
        );

      const closeTunnel = (tunnelId: string, reason: string | undefined, notify: boolean) =>
        Effect.gen(function* () {
          const tunnel = tunnels.get(tunnelId);
          tunnels.delete(tunnelId);
          if (tunnel !== undefined) yield* tunnel.close;
          if (notify) {
            yield* send({
              type: "env.close",
              tunnelId,
              ...(reason !== undefined ? { reason } : {}),
            });
          }
        });

      // The backend enforces pairing too; this is the host's own line of defence.
      const openTunnel = (input: {
        readonly tunnelId: string;
        readonly peerHostId: string;
        readonly path: string | undefined;
      }) =>
        Effect.gen(function* () {
          if (!pairedHostIds.has(input.peerHostId)) {
            yield* Effect.logWarning("host bridge refused tunnel from unpaired host", {
              peerHostId: input.peerHostId,
            });
            yield* send({ type: "env.close", tunnelId: input.tunnelId, reason: "unpaired" });
            return;
          }
          if (tunnels.has(input.tunnelId)) return;
          const connection = yield* tunnelTarget.connect({ path: input.path }).pipe(Effect.result);
          if (connection._tag === "Failure") {
            yield* send({
              type: "env.close",
              tunnelId: input.tunnelId,
              reason: connection.failure.message,
            });
            return;
          }
          tunnels.set(input.tunnelId, connection.success);
          yield* Effect.forkScoped(
            Stream.runForEach(Stream.fromQueue(connection.success.incoming), (bytes) =>
              send({
                type: "env.frame",
                tunnelId: input.tunnelId,
                payload: Encoding.encodeBase64(bytes),
              }),
            ).pipe(
              Effect.andThen(
                tunnels.get(input.tunnelId) === connection.success
                  ? closeTunnel(input.tunnelId, "closed", true)
                  : Effect.void,
              ),
            ),
          );
        });

      const handleFrame = (frame: BackendToHostFrame) =>
        Effect.gen(function* () {
          switch (frame.type) {
            case "welcome": {
              welcomes += 1;
              for (const hostId of frame.pairedHostIds ?? []) pairedHostIds.add(hostId);
              yield* Deferred.succeed(welcome, { heartbeatSeconds: frame.heartbeatSeconds });
              return;
            }
            case "ping":
              yield* send({ type: "pong" });
              return;
            case "pong":
              missedPongs = 0;
              return;
            case "turn.deliver": {
              yield* send({ type: "turn.ack", turnId: frame.turnId });
              if (seenTurns.has(frame.turnId)) return;
              rememberTurn(frame.turnId);
              yield* Effect.forkScoped(deliverTurn(frame));
              return;
            }
            case "turn.interrupt": {
              const sessionId = frame.sessionId ?? turnSessions.get(frame.turnId);
              const active = sessionId === undefined ? undefined : activeTurns.get(sessionId);
              if (
                sessionId === undefined ||
                active === undefined ||
                active.turnId !== frame.turnId
              ) {
                yield* finishTurn(frame.turnId, { exitCode: 0, interrupted: true });
                return;
              }
              active.interrupted = true;
              yield* runtime.interruptTurn({ sessionId, turnId: frame.turnId }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("host bridge interrupt failed", {
                    turnId: frame.turnId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
              return;
            }
            case "checkpoint.request": {
              const result = yield* runtime
                .createCheckpoint({ sessionId: frame.sessionId, reason: frame.reason })
                .pipe(Effect.result);
              yield* result._tag === "Success"
                ? send({
                    type: "checkpoint.done",
                    sessionId: frame.sessionId,
                    generation: result.success.generation,
                  })
                : send({
                    type: "checkpoint.failed",
                    sessionId: frame.sessionId,
                    error: result.failure.message,
                  });
              return;
            }
            case "hosts.paired": {
              pairedHostIds.clear();
              for (const hostId of frame.hostIds) pairedHostIds.add(hostId);
              return;
            }
            case "env.open":
              yield* openTunnel({
                tunnelId: frame.tunnelId,
                peerHostId: frame.peerHostId,
                path: frame.path,
              });
              return;
            case "env.frame": {
              const tunnel = tunnels.get(frame.tunnelId);
              if (tunnel === undefined) {
                yield* send({
                  type: "env.close",
                  tunnelId: frame.tunnelId,
                  reason: "unknown tunnel",
                });
                return;
              }
              const bytes = Encoding.decodeBase64(frame.payload);
              if (bytes._tag === "Failure") {
                yield* closeTunnel(frame.tunnelId, "bad payload", true);
                return;
              }
              yield* tunnel
                .send(bytes.success)
                .pipe(Effect.catchCause(() => closeTunnel(frame.tunnelId, "send failed", true)));
              return;
            }
            case "env.close":
              yield* closeTunnel(frame.tunnelId, undefined, false);
              return;
            case "prompt.answer": {
              yield* runtime
                .answerPrompt({ sessionId: null, promptId: frame.promptId, value: frame.value })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("host bridge prompt answer failed", {
                      promptId: frame.promptId,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                );
              return;
            }
          }
        });

      const handleText = (text: string) =>
        decodeBackendToHostFrame(text).pipe(
          Effect.flatMap(handleFrame),
          Effect.catchCause((cause) =>
            Effect.logWarning("host bridge dropped frame", { cause: Cause.pretty(cause) }),
          ),
        );

      const incoming = yield* Effect.forkScoped(
        Stream.runForEach(Stream.fromQueue(socket.incoming), handleText),
      );

      yield* send({
        type: "hello",
        kind: "desktop",
        name: config.hostName,
        platform: config.platform,
        version: config.version,
        capabilities: {
          harnesses: ["claude-code", "codex"],
          attachments: true,
          headless: true,
          teleport: false,
        },
      });

      const welcomed = yield* Deferred.await(welcome).pipe(Effect.timeoutOption(WELCOME_TIMEOUT));
      if (Option.isNone(welcomed)) {
        yield* socket.close;
        return yield* new HostBridgeSocketError({ detail: "Host bridge welcome timed out." });
      }
      yield* Effect.logInfo("host bridge connected", { url: config.socketUrl });

      for (const session of yield* runtime.listSessions) {
        yield* announceSession(session);
      }

      yield* Effect.forkScoped(
        Stream.runForEach(runtime.events, (event) => {
          switch (event.type) {
            case "session.upserted":
              return announceSession(event.session);
            case "session.closed": {
              if (!announced.has(event.sessionId)) return Effect.void;
              announced.delete(event.sessionId);
              announcedCommands.delete(event.sessionId);
              const active = activeTurns.get(event.sessionId);
              activeTurns.delete(event.sessionId);
              return (
                active === undefined
                  ? Effect.void
                  : finishTurn(active.turnId, { exitCode: 0, interrupted: active.interrupted })
              ).pipe(Effect.andThen(send({ type: "session.closed", sessionId: event.sessionId })));
            }
            case "prompt.pending":
              return send({
                type: "prompt.request",
                promptId: event.prompt.promptId,
                sessionId: event.prompt.sessionId,
                kind: event.prompt.kind,
                text: event.prompt.text,
                ...(event.prompt.options !== undefined ? { options: event.prompt.options } : {}),
                ...(event.prompt.default !== undefined ? { default: event.prompt.default } : {}),
              });
          }
        }),
      );

      const heartbeat =
        options.heartbeatOverride ?? Duration.seconds(Math.max(1, welcomed.value.heartbeatSeconds));
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(heartbeat);
            if (missedPongs >= HOST_BRIDGE_MAX_MISSED_HEARTBEATS) {
              yield* Effect.logWarning("host bridge missed heartbeats; reconnecting");
              yield* socket.close;
              return;
            }
            missedPongs += 1;
            yield* send({ type: "ping" });
          }
        }),
      );

      // The incoming loop ends when the peer (or the heartbeat) closes the socket.
      yield* Fiber.join(incoming);
      for (const tunnel of tunnels.values()) yield* tunnel.close;
      tunnels.clear();
    }).pipe(Effect.scoped);

  const reconnectMin = options.reconnectMin ?? RECONNECT_MIN;
  const reconnectMax = options.reconnectMax ?? RECONNECT_MAX;

  let backoff = reconnectMin;
  const attempt = Effect.gen(function* () {
    const before = welcomes;
    const outcome = yield* factory
      .connect({ url: config.socketUrl, bearerToken: config.deviceLinkKey })
      .pipe(
        Effect.flatMap((socket) => serveConnection(socket).pipe(Effect.ensuring(socket.close))),
        Effect.result,
      );
    if (outcome._tag === "Failure") {
      yield* Effect.logWarning("host bridge connection failed", {
        detail: outcome.failure.message,
      });
    } else {
      yield* Effect.logInfo("host bridge disconnected");
    }
    backoff =
      welcomes > before ? reconnectMin : Duration.min(reconnectMax, Duration.times(backoff, 2));
    yield* Effect.sleep(backoff);
  });
  const run = Effect.forever(attempt).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  return {
    run,
    connections: Effect.sync(() => welcomes),
  } satisfies HostBridgeClient;
});

export type { HostBridgeRuntimeShape };
