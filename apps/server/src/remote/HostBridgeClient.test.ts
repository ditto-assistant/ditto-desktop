import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { BackendToHostFrame, HostToBackendFrame } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Encoding from "effect/Encoding";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { HostBridgeAttachmentError, HostBridgeFetch } from "./HostBridgeAttachments.ts";
import { makeHostBridgeClient } from "./HostBridgeClient.ts";
import { HostBridgeConfig } from "./HostBridgeConfig.ts";
import {
  HostBridgeRuntime,
  HostBridgeRuntimeError,
  type HostBridgeRuntimeEvent,
  type HostBridgeRuntimeShape,
  type HostBridgeSession,
} from "./HostBridgeRuntime.ts";
import { HostBridgeSocketFactory, type HostBridgeSocket } from "./HostBridgeSocket.ts";
import {
  HostBridgeTunnelError,
  HostBridgeTunnelTarget,
  type HostBridgeTunnelConnection,
} from "./HostBridgeTunnel.ts";

// ---------------------------------------------------------------------------
// Stub backend: an in-memory socket per connection attempt.
// ---------------------------------------------------------------------------

interface StubSocket {
  readonly socket: HostBridgeSocket;
  /** Backend → host. */
  readonly push: (frame: typeof BackendToHostFrame.Encoded) => Effect.Effect<void>;
  /** Host → backend, decoded. */
  readonly next: Effect.Effect<HostToBackendFrame>;
  /** Drains frames until one of `type` shows up. */
  readonly expect: (type: HostToBackendFrame["type"]) => Effect.Effect<HostToBackendFrame>;
  readonly dropFromBackend: Effect.Effect<void>;
  readonly closed: Deferred.Deferred<void>;
}

const makeStubBackend = Effect.gen(function* () {
  const sockets: StubSocket[] = [];
  const connections = yield* Queue.unbounded<StubSocket>();
  const connect = Effect.gen(function* () {
    const toHost = yield* Queue.unbounded<string, Cause.Done>();
    const toBackend = yield* Queue.unbounded<string>();
    const closed = yield* Deferred.make<void>();
    const next = Queue.take(toBackend).pipe(
      Effect.map((text) => JSON.parse(text) as HostToBackendFrame),
      Effect.orDie,
    );
    const stub: StubSocket = {
      socket: {
        incoming: toHost,
        send: (text) => Queue.offer(toBackend, text).pipe(Effect.asVoid),
        close: Effect.gen(function* () {
          yield* Queue.end(toHost);
          yield* Deferred.succeed(closed, undefined);
        }),
      },
      push: (frame) => Queue.offer(toHost, JSON.stringify(frame)).pipe(Effect.asVoid),
      next,
      expect: (type) =>
        Effect.gen(function* () {
          while (true) {
            const frame = yield* next;
            if (frame.type === type) return frame;
          }
        }),
      dropFromBackend: Queue.end(toHost).pipe(Effect.asVoid),
      closed,
    };
    sockets.push(stub);
    yield* Queue.offer(connections, stub);
    return stub.socket;
  });
  const layer = Layer.succeed(HostBridgeSocketFactory, { connect: () => connect });
  const awaitConnection = Queue.take(connections).pipe(Effect.orDie);
  return { layer, awaitConnection, sockets };
});

// ---------------------------------------------------------------------------
// Fake runtime.
// ---------------------------------------------------------------------------

const session = (overrides: Partial<HostBridgeSession> = {}): HostBridgeSession => ({
  sessionId: "thread-1",
  harness: "claude-code",
  cwd: "/tmp/does-not-matter",
  mode: "headless",
  status: "idle",
  title: "Fix the tests",
  commands: [{ name: "review", source: "builtin", headless: true }],
  ...overrides,
});

const makeFakeRuntime = (sessions: ReadonlyArray<HostBridgeSession>) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<HostBridgeRuntimeEvent>();
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const runtime: HostBridgeRuntimeShape = {
      listSessions: Effect.succeed(sessions),
      events: Stream.fromQueue(events),
      submitTurn: (input) => Effect.sync(() => void calls.push({ method: "submitTurn", input })),
      submitCommand: (input) =>
        Effect.sync(() => {
          calls.push({ method: "submitCommand", input });
          return input.name === "compact" ? { unsupported: "TUI-only command" } : {};
        }),
      answerPrompt: (input) =>
        Effect.sync(() => void calls.push({ method: "answerPrompt", input })),
      interruptTurn: (input) =>
        Effect.sync(() => void calls.push({ method: "interruptTurn", input })),
      createCheckpoint: (input) =>
        input.sessionId === "thread-1"
          ? Effect.succeed({ generation: "gen-7" })
          : Effect.fail(new HostBridgeRuntimeError({ detail: "no checkpoint" })),
    };
    return { runtime, events, calls, layer: Layer.succeed(HostBridgeRuntime, runtime) };
  });

const configLayer = Layer.succeed(HostBridgeConfig, {
  enabled: true,
  apiBaseUrl: "https://api.example.test",
  socketUrl: "wss://api.example.test/api/v5/hosts/ws",
  deviceLinkKey: "ditto_mcp_test",
  hostName: "test-host",
  platform: "darwin",
  version: "0.0.0-test",
});

const bytesFor = (text: string) => new TextEncoder().encode(text);
const sha256 = (text: string) =>
  NodeCrypto.createHash("sha256").update(bytesFor(text)).digest("hex");

const fetchLayer = (files: Record<string, string>) =>
  Layer.succeed(HostBridgeFetch, {
    download: (url) => {
      const body = files[url];
      return body === undefined
        ? Effect.fail(new HostBridgeAttachmentError({ attachmentId: url, detail: "missing" }))
        : Effect.succeed(bytesFor(body));
    },
  });

// ---------------------------------------------------------------------------
// Stub local RPC listener for environment tunnels.
// ---------------------------------------------------------------------------

const makeStubTunnelTarget = Effect.gen(function* () {
  const opened: Array<{ readonly path: string | undefined; readonly received: Uint8Array[] }> = [];
  const toHost = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  let closed = 0;
  const target = {
    connect: ({ path }: { readonly path: string | undefined }) =>
      Effect.gen(function* () {
        if (path === "/refuse") {
          return yield* new HostBridgeTunnelError({ detail: "listener down" });
        }
        const received: Uint8Array[] = [];
        opened.push({ path, received });
        return {
          incoming: toHost,
          send: (bytes: Uint8Array) => Effect.sync(() => void received.push(bytes)),
          close: Effect.sync(() => void (closed += 1)),
        } satisfies HostBridgeTunnelConnection;
      }),
  };
  return {
    layer: Layer.succeed(HostBridgeTunnelTarget, target),
    opened,
    emit: (bytes: Uint8Array) => Queue.offer(toHost, bytes).pipe(Effect.asVoid),
    end: Queue.end(toHost).pipe(Effect.asVoid),
    closedCount: () => closed,
  };
});

const welcome = (heartbeatSeconds = 3600): typeof BackendToHostFrame.Encoded => ({
  type: "welcome",
  hostId: "host-1",
  heartbeatSeconds,
  pairedHostIds: ["host-laptop"],
});

const startClient = (input: {
  readonly sessions: ReadonlyArray<HostBridgeSession>;
  readonly files?: Record<string, string>;
  readonly heartbeat?: Duration.Duration;
}) =>
  Effect.gen(function* () {
    const backend = yield* makeStubBackend;
    const fake = yield* makeFakeRuntime(input.sessions);
    const tunnelTarget = yield* makeStubTunnelTarget;
    const client = yield* makeHostBridgeClient({
      heartbeatOverride: input.heartbeat,
      reconnectMin: Duration.millis(5),
      reconnectMax: Duration.millis(20),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          configLayer,
          backend.layer,
          fake.layer,
          fetchLayer(input.files ?? {}),
          tunnelTarget.layer,
        ),
      ),
    );
    yield* Effect.forkScoped(client.run);
    const socket = yield* backend.awaitConnection;
    expect(yield* socket.next).toMatchObject({ type: "hello", kind: "desktop", name: "test-host" });
    yield* socket.push(welcome());
    return { backend, fake, client, socket, tunnelTarget };
  });

const tempCwd = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ditto-host-" });
  yield* fs.makeDirectory(path.join(dir, ".git"), { recursive: true });
  return dir;
});

const readText = (...segments: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(...segments));
  });

const withNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// ---------------------------------------------------------------------------

it.live("announces sessions and their command catalog after welcome", () =>
  Effect.gen(function* () {
    const { socket } = yield* startClient({ sessions: [session()] });
    expect(yield* socket.next).toMatchObject({
      type: "session.announce",
      sessionId: "thread-1",
      harness: "claude-code",
      status: "idle",
      title: "Fix the tests",
    });
    expect(yield* socket.next).toMatchObject({
      type: "session.commands",
      sessionId: "thread-1",
      commands: [{ name: "review" }],
    });
  }).pipe(withNode),
);

it.live("delivers a prompt turn with attachments and finishes when the session goes idle", () =>
  Effect.gen(function* () {
    const cwd = yield* tempCwd;
    const { socket, fake } = yield* startClient({
      sessions: [session({ cwd })],
      files: { "https://files.test/notes.txt": "hello from the app" },
    });
    yield* socket.expect("session.commands");

    yield* socket.push({
      type: "turn.deliver",
      turnId: "turn-1",
      sessionId: "thread-1",
      text: "Read the notes",
      kind: "prompt",
      attachments: [
        {
          id: "att-1",
          name: "../notes.txt",
          mime: "text/plain",
          size: 18,
          sha256: sha256("hello from the app"),
          url: "https://files.test/notes.txt",
        },
      ],
    });
    expect(yield* socket.next).toEqual({ type: "turn.ack", turnId: "turn-1" });
    expect(yield* socket.next).toEqual({ type: "turn.started", turnId: "turn-1" });

    const relative = ".tmp/ditto/attachments/turn-1/notes.txt";
    expect(fake.calls).toEqual([
      {
        method: "submitTurn",
        input: {
          sessionId: "thread-1",
          turnId: "turn-1",
          text: `Read the notes\n\nAttached files:\n- ${relative}`,
        },
      },
    ]);
    expect(yield* readText(cwd, relative)).toBe("hello from the app");
    expect(yield* readText(cwd, ".git", "info", "exclude")).toContain("/.tmp/ditto/");

    // A redelivery is acknowledged but not run twice.
    yield* socket.push({
      type: "turn.deliver",
      turnId: "turn-1",
      sessionId: "thread-1",
      text: "again",
    });
    expect(yield* socket.next).toEqual({ type: "turn.ack", turnId: "turn-1" });
    expect(fake.calls).toHaveLength(1);

    yield* Queue.offer(fake.events, {
      type: "session.upserted",
      session: session({ cwd, status: "running" }),
    });
    expect(yield* socket.next).toEqual({
      type: "session.status",
      sessionId: "thread-1",
      status: "running",
    });
    yield* Queue.offer(fake.events, { type: "session.upserted", session: session({ cwd }) });
    expect(yield* socket.next).toEqual({
      type: "session.status",
      sessionId: "thread-1",
      status: "idle",
    });
    expect(yield* socket.next).toEqual({ type: "turn.finished", turnId: "turn-1", exitCode: 0 });
  }).pipe(withNode),
);

it.live("reports a failed attachment download as a failed turn", () =>
  Effect.gen(function* () {
    const cwd = yield* tempCwd;
    const { socket, fake } = yield* startClient({ sessions: [session({ cwd })] });
    yield* socket.expect("session.commands");
    yield* socket.push({
      type: "turn.deliver",
      turnId: "turn-x",
      sessionId: "thread-1",
      text: "x",
      attachments: [
        {
          id: "a",
          name: "gone.bin",
          mime: "application/octet-stream",
          size: 1,
          sha256: "",
          url: "https://files.test/gone",
        },
      ],
    });
    expect(yield* socket.next).toEqual({ type: "turn.ack", turnId: "turn-x" });
    expect(yield* socket.next).toMatchObject({
      type: "turn.finished",
      turnId: "turn-x",
      exitCode: 1,
    });
    expect(fake.calls).toEqual([]);
  }).pipe(withNode),
);

it.live("runs command turns through the runtime and flags unsupported ones (v1.1)", () =>
  Effect.gen(function* () {
    const { socket, fake } = yield* startClient({ sessions: [session()] });
    yield* socket.expect("session.commands");

    yield* socket.push({
      type: "turn.deliver",
      turnId: "turn-c1",
      sessionId: "thread-1",
      kind: "command",
      command: { name: "compact", args: "" },
    });
    expect(yield* socket.next).toEqual({ type: "turn.ack", turnId: "turn-c1" });
    expect(yield* socket.next).toEqual({
      type: "turn.finished",
      turnId: "turn-c1",
      exitCode: 0,
      unsupported: "TUI-only command",
    });

    yield* socket.push({
      type: "turn.deliver",
      turnId: "turn-c2",
      sessionId: "thread-1",
      kind: "command",
      command: { name: "review", args: "--focus tests" },
    });
    expect(yield* socket.next).toEqual({ type: "turn.ack", turnId: "turn-c2" });
    expect(yield* socket.next).toEqual({ type: "turn.started", turnId: "turn-c2" });
    expect(fake.calls.at(-1)).toEqual({
      method: "submitCommand",
      input: { sessionId: "thread-1", turnId: "turn-c2", name: "review", args: "--focus tests" },
    });
  }).pipe(withNode),
);

it.live("forwards pending prompts and routes answers back (v1.1)", () =>
  Effect.gen(function* () {
    const { socket, fake } = yield* startClient({ sessions: [session()] });
    yield* socket.expect("session.commands");

    yield* Queue.offer(fake.events, {
      type: "prompt.pending",
      prompt: {
        promptId: "approval:req-1",
        sessionId: "thread-1",
        kind: "permission",
        text: "Run `rm -rf dist`?",
        options: [{ id: "accept", label: "Allow" }],
        default: "accept",
      },
    });
    expect(yield* socket.next).toEqual({
      type: "prompt.request",
      promptId: "approval:req-1",
      sessionId: "thread-1",
      kind: "permission",
      text: "Run `rm -rf dist`?",
      options: [{ id: "accept", label: "Allow" }],
      default: "accept",
    });

    yield* socket.push({ type: "prompt.answer", promptId: "approval:req-1", value: "accept" });
    yield* socket.push({
      type: "turn.deliver",
      turnId: "turn-a",
      sessionId: "thread-1",
      kind: "answer",
      answer: { promptId: "question:req-2", value: "blue" },
    });
    expect(yield* socket.next).toEqual({ type: "turn.ack", turnId: "turn-a" });
    expect(yield* socket.next).toEqual({ type: "turn.started", turnId: "turn-a" });
    expect(yield* socket.next).toEqual({ type: "turn.finished", turnId: "turn-a", exitCode: 0 });
    expect(fake.calls).toEqual([
      {
        method: "answerPrompt",
        input: { sessionId: null, promptId: "approval:req-1", value: "accept" },
      },
      {
        method: "answerPrompt",
        input: { sessionId: "thread-1", promptId: "question:req-2", value: "blue" },
      },
    ]);
  }).pipe(withNode),
);

it.live("interrupts the active turn and reports it as interrupted", () =>
  Effect.gen(function* () {
    const { socket, fake } = yield* startClient({ sessions: [session()] });
    yield* socket.expect("session.commands");
    yield* socket.push({
      type: "turn.deliver",
      turnId: "turn-i",
      sessionId: "thread-1",
      text: "go",
    });
    yield* socket.expect("turn.started");

    yield* socket.push({ type: "turn.interrupt", turnId: "turn-i" });
    yield* Queue.offer(fake.events, {
      type: "session.upserted",
      session: session({ status: "running" }),
    });
    yield* Queue.offer(fake.events, { type: "session.upserted", session: session() });
    expect(yield* socket.expect("turn.finished")).toEqual({
      type: "turn.finished",
      turnId: "turn-i",
      exitCode: 0,
      interrupted: true,
    });
    expect(fake.calls.at(-1)).toEqual({
      method: "interruptTurn",
      input: { sessionId: "thread-1", turnId: "turn-i" },
    });

    // An unknown turn is answered as already finished so the backend can settle it.
    yield* socket.push({ type: "turn.interrupt", turnId: "turn-unknown" });
    expect(yield* socket.next).toEqual({
      type: "turn.finished",
      turnId: "turn-unknown",
      exitCode: 0,
      interrupted: true,
    });
  }).pipe(withNode),
);

it.live("answers checkpoint requests with done or failed", () =>
  Effect.gen(function* () {
    const { socket } = yield* startClient({
      sessions: [session(), session({ sessionId: "thread-2", title: "Other" })],
    });
    yield* socket.expect("session.commands");
    yield* socket.expect("session.commands");
    yield* socket.push({ type: "checkpoint.request", sessionId: "thread-1", reason: "turn-end" });
    expect(yield* socket.next).toEqual({
      type: "checkpoint.done",
      sessionId: "thread-1",
      generation: "gen-7",
    });
    yield* socket.push({ type: "checkpoint.request", sessionId: "thread-2" });
    expect(yield* socket.next).toEqual({
      type: "checkpoint.failed",
      sessionId: "thread-2",
      error: "no checkpoint",
    });
  }).pipe(withNode),
);

it.live("answers pings, reconnects after three missed pongs, and re-announces", () =>
  Effect.gen(function* () {
    const { socket, backend } = yield* startClient({
      sessions: [session()],
      heartbeat: Duration.millis(10),
    });
    yield* socket.expect("session.commands");
    yield* socket.push({ type: "ping" });
    expect(yield* socket.expect("pong")).toEqual({ type: "pong" });

    // Never answer the client's pings: it must give up after three and reconnect.
    yield* Deferred.await(socket.closed);
    const reconnected = yield* backend.awaitConnection;
    expect(yield* reconnected.next).toMatchObject({ type: "hello" });
    yield* reconnected.push(welcome());
    expect(yield* reconnected.next).toMatchObject({
      type: "session.announce",
      sessionId: "thread-1",
    });
    expect(backend.sockets).toHaveLength(2);
  }).pipe(withNode),
);

it.live("reconnects when the backend drops the socket", () =>
  Effect.gen(function* () {
    const { socket, backend } = yield* startClient({ sessions: [] });
    yield* socket.dropFromBackend;
    const reconnected = yield* backend.awaitConnection;
    expect(yield* reconnected.next).toMatchObject({ type: "hello" });
  }).pipe(withNode),
);

it.live("bridges an environment tunnel from a paired host to the local listener", () =>
  Effect.gen(function* () {
    const { socket, tunnelTarget } = yield* startClient({ sessions: [] });
    yield* socket.push({
      type: "env.open",
      tunnelId: "tun-1",
      peerHostId: "host-laptop",
      path: "/ws",
    });
    yield* socket.push({
      type: "env.frame",
      tunnelId: "tun-1",
      payload: Encoding.encodeBase64(new TextEncoder().encode("rpc request")),
    });
    yield* tunnelTarget.emit(new TextEncoder().encode("rpc response"));
    expect(yield* socket.next).toEqual({
      type: "env.frame",
      tunnelId: "tun-1",
      payload: Encoding.encodeBase64(new TextEncoder().encode("rpc response")),
    });
    expect(tunnelTarget.opened.map((entry) => entry.path)).toEqual(["/ws"]);
    expect(new TextDecoder().decode(tunnelTarget.opened[0]!.received[0])).toBe("rpc request");

    // Listener closes → the backend hears env.close.
    yield* tunnelTarget.end;
    expect(yield* socket.next).toEqual({ type: "env.close", tunnelId: "tun-1", reason: "closed" });

    // Backend closes → the local connection is closed without an echo.
    yield* socket.push({ type: "env.open", tunnelId: "tun-2", peerHostId: "host-laptop" });
    yield* socket.push({ type: "env.close", tunnelId: "tun-2" });
    yield* socket.push({ type: "ping" });
    expect(yield* socket.next).toEqual({ type: "pong" });
    expect(tunnelTarget.closedCount()).toBeGreaterThanOrEqual(2);
  }).pipe(withNode),
);

it.live("refuses tunnels from hosts that are not paired and reports listener failures", () =>
  Effect.gen(function* () {
    const { socket, tunnelTarget } = yield* startClient({ sessions: [] });
    yield* socket.push({ type: "env.open", tunnelId: "tun-x", peerHostId: "host-stranger" });
    expect(yield* socket.next).toEqual({
      type: "env.close",
      tunnelId: "tun-x",
      reason: "unpaired",
    });
    expect(tunnelTarget.opened).toHaveLength(0);

    // Pairing can change while connected.
    yield* socket.push({ type: "hosts.paired", hostIds: ["host-stranger"] });
    yield* socket.push({
      type: "env.open",
      tunnelId: "tun-y",
      peerHostId: "host-stranger",
      path: "/refuse",
    });
    expect(yield* socket.next).toEqual({
      type: "env.close",
      tunnelId: "tun-y",
      reason: "listener down",
    });
    yield* socket.push({ type: "env.open", tunnelId: "tun-z", peerHostId: "host-laptop" });
    expect(yield* socket.next).toEqual({
      type: "env.close",
      tunnelId: "tun-z",
      reason: "unpaired",
    });

    // Frames for unknown tunnels are answered with a close so the backend can settle.
    yield* socket.push({ type: "env.frame", tunnelId: "nope", payload: "" });
    expect(yield* socket.next).toEqual({
      type: "env.close",
      tunnelId: "nope",
      reason: "unknown tunnel",
    });
  }).pipe(withNode),
);
