// DITTO: host bridge protocol v1 (+ v1.1 addendum) between a host (desktop
// server or heyditto CLI) and the Ditto backend over `wss://<api>/api/v5/hosts/ws`.
// JSON frames discriminated by `type`. See DITTO-TEMPORAL-SESSION-FABRIC.md.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HOST_BRIDGE_PATH = "/api/v5/hosts/ws";
const HOST_BRIDGE_DEFAULT_HEARTBEAT_SECONDS = 30;
/** A host that misses this many pongs in a row is offline; it drops the socket and reconnects. */
export const HOST_BRIDGE_MAX_MISSED_HEARTBEATS = 3;

export const HostBridgeHarness = Schema.Literals(["claude-code", "codex"]);
export type HostBridgeHarness = typeof HostBridgeHarness.Type;

export const HostBridgeHostKind = Schema.Literals(["cli", "desktop"]);
export type HostBridgeHostKind = typeof HostBridgeHostKind.Type;

export const HostBridgeSessionMode = Schema.Literals(["tui", "headless"]);
export type HostBridgeSessionMode = typeof HostBridgeSessionMode.Type;

export const HostBridgeSessionStatus = Schema.Literals(["idle", "running"]);
export type HostBridgeSessionStatus = typeof HostBridgeSessionStatus.Type;

export const HostBridgeCommandSource = Schema.Literals(["builtin", "custom", "skill", "plugin"]);
export type HostBridgeCommandSource = typeof HostBridgeCommandSource.Type;

export const HostBridgeCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  source: HostBridgeCommandSource,
  argsHint: Schema.optional(Schema.String),
  /** Whether the command works when the session runs headless. */
  headless: Schema.Boolean,
});
export type HostBridgeCommand = typeof HostBridgeCommand.Type;

export const HostBridgeAttachment = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  mime: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  /** Presigned GET url, valid for ~15 minutes. */
  url: Schema.String,
});
export type HostBridgeAttachment = typeof HostBridgeAttachment.Type;

export const HostBridgePromptKind = Schema.Literals(["permission", "question", "choice"]);
export type HostBridgePromptKind = typeof HostBridgePromptKind.Type;

export const HostBridgePromptOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
});
export type HostBridgePromptOption = typeof HostBridgePromptOption.Type;

export const HostBridgeCapabilities = Schema.Struct({
  harnesses: Schema.Array(HostBridgeHarness),
  attachments: Schema.Boolean,
  headless: Schema.Boolean,
  teleport: Schema.Boolean,
});
export type HostBridgeCapabilities = typeof HostBridgeCapabilities.Type;

// ---------------------------------------------------------------------------
// host → backend
// ---------------------------------------------------------------------------

export const HostBridgeHelloFrame = Schema.Struct({
  type: Schema.Literal("hello"),
  kind: HostBridgeHostKind,
  name: Schema.String,
  platform: Schema.String,
  version: Schema.String,
  capabilities: HostBridgeCapabilities,
});

export const HostBridgeSessionAnnounceFrame = Schema.Struct({
  type: Schema.Literal("session.announce"),
  sessionId: TrimmedNonEmptyString,
  harness: HostBridgeHarness,
  cwd: Schema.String,
  mode: HostBridgeSessionMode,
  status: HostBridgeSessionStatus,
  title: Schema.optional(Schema.String),
});

export const HostBridgeSessionClosedFrame = Schema.Struct({
  type: Schema.Literal("session.closed"),
  sessionId: TrimmedNonEmptyString,
});

export const HostBridgeSessionStatusFrame = Schema.Struct({
  type: Schema.Literal("session.status"),
  sessionId: TrimmedNonEmptyString,
  status: HostBridgeSessionStatus,
});

/** v1.1: the harness command catalog, sent after `session.announce` and whenever it changes. */
export const HostBridgeSessionCommandsFrame = Schema.Struct({
  type: Schema.Literal("session.commands"),
  sessionId: TrimmedNonEmptyString,
  harness: HostBridgeHarness,
  commands: Schema.Array(HostBridgeCommand),
});

export const HostBridgeTurnAckFrame = Schema.Struct({
  type: Schema.Literal("turn.ack"),
  turnId: TrimmedNonEmptyString,
});

export const HostBridgeTurnStartedFrame = Schema.Struct({
  type: Schema.Literal("turn.started"),
  turnId: TrimmedNonEmptyString,
});

export const HostBridgeTurnFinishedFrame = Schema.Struct({
  type: Schema.Literal("turn.finished"),
  turnId: TrimmedNonEmptyString,
  exitCode: Schema.optional(Schema.Number),
  interrupted: Schema.optional(Schema.Boolean),
  /** v1.1: set when a `command` turn cannot run in this session's mode. */
  unsupported: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

export const HostBridgeCheckpointDoneFrame = Schema.Struct({
  type: Schema.Literal("checkpoint.done"),
  sessionId: TrimmedNonEmptyString,
  generation: Schema.String,
});

export const HostBridgeCheckpointFailedFrame = Schema.Struct({
  type: Schema.Literal("checkpoint.failed"),
  sessionId: TrimmedNonEmptyString,
  error: Schema.String,
});

/** v1.1: the harness is waiting on the user (tool permission, question, choice). */
export const HostBridgePromptRequestFrame = Schema.Struct({
  type: Schema.Literal("prompt.request"),
  promptId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  kind: HostBridgePromptKind,
  text: Schema.String,
  options: Schema.optional(Schema.Array(HostBridgePromptOption)),
  default: Schema.optional(Schema.String),
});

// ---------------------------------------------------------------------------
// Environment tunnel (both directions): a paired host reaches this server's
// local RPC listener through the backend (`/api/v5/hosts/{hostId}/env`).
// ---------------------------------------------------------------------------

export const HostBridgeTunnelId = TrimmedNonEmptyString;

/** Bytes for an open tunnel, base64 in both directions. */
export const HostBridgeEnvFrame = Schema.Struct({
  type: Schema.Literal("env.frame"),
  tunnelId: HostBridgeTunnelId,
  payload: Schema.String,
});

export const HostBridgeEnvCloseFrame = Schema.Struct({
  type: Schema.Literal("env.close"),
  tunnelId: HostBridgeTunnelId,
  reason: Schema.optional(Schema.String),
});

/** Hosts this host is paired with; sent with `welcome` and whenever the set changes. */
export const HostBridgeHostsPairedFrame = Schema.Struct({
  type: Schema.Literal("hosts.paired"),
  hostIds: Schema.Array(TrimmedNonEmptyString),
});

export const HostBridgePingFrame = Schema.Struct({ type: Schema.Literal("ping") });
export const HostBridgePongFrame = Schema.Struct({ type: Schema.Literal("pong") });

export const HostToBackendFrame = Schema.Union([
  HostBridgeHelloFrame,
  HostBridgeSessionAnnounceFrame,
  HostBridgeSessionClosedFrame,
  HostBridgeSessionStatusFrame,
  HostBridgeSessionCommandsFrame,
  HostBridgeTurnAckFrame,
  HostBridgeTurnStartedFrame,
  HostBridgeTurnFinishedFrame,
  HostBridgeCheckpointDoneFrame,
  HostBridgeCheckpointFailedFrame,
  HostBridgePromptRequestFrame,
  HostBridgeEnvFrame,
  HostBridgeEnvCloseFrame,
  HostBridgePingFrame,
  HostBridgePongFrame,
]);
export type HostToBackendFrame = typeof HostToBackendFrame.Type;

// ---------------------------------------------------------------------------
// backend → host
// ---------------------------------------------------------------------------

export const HostBridgeWelcomeFrame = Schema.Struct({
  type: Schema.Literal("welcome"),
  hostId: TrimmedNonEmptyString,
  heartbeatSeconds: Schema.Number.pipe(
    Schema.withDecodingDefault(Effect.succeed(HOST_BRIDGE_DEFAULT_HEARTBEAT_SECONDS)),
  ),
  serverTime: Schema.optional(Schema.String),
  /** Hosts already paired with this one; refreshed by `hosts.paired`. */
  pairedHostIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});

export const HostBridgeTurnKind = Schema.Literals(["prompt", "command", "answer"]);
export type HostBridgeTurnKind = typeof HostBridgeTurnKind.Type;

export const HostBridgeTurnDeliverFrame = Schema.Struct({
  type: Schema.Literal("turn.deliver"),
  turnId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  text: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  attachments: Schema.Array(HostBridgeAttachment).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  kind: HostBridgeTurnKind.pipe(Schema.withDecodingDefault(Effect.succeed("prompt" as const))),
  command: Schema.optional(Schema.Struct({ name: TrimmedNonEmptyString, args: Schema.String })),
  answer: Schema.optional(Schema.Struct({ promptId: TrimmedNonEmptyString, value: Schema.String })),
});
export type HostBridgeTurnDeliverFrame = typeof HostBridgeTurnDeliverFrame.Type;

export const HostBridgeTurnInterruptFrame = Schema.Struct({
  type: Schema.Literal("turn.interrupt"),
  turnId: TrimmedNonEmptyString,
  sessionId: Schema.optional(TrimmedNonEmptyString),
});

export const HostBridgeCheckpointRequestFrame = Schema.Struct({
  type: Schema.Literal("checkpoint.request"),
  sessionId: TrimmedNonEmptyString,
  reason: Schema.optional(Schema.String),
});

export const HostBridgePromptAnswerFrame = Schema.Struct({
  type: Schema.Literal("prompt.answer"),
  promptId: TrimmedNonEmptyString,
  value: Schema.String,
});

/** Backend asks the host to open a tunnel from `peerHostId` to its local RPC listener. */
export const HostBridgeEnvOpenFrame = Schema.Struct({
  type: Schema.Literal("env.open"),
  tunnelId: HostBridgeTunnelId,
  /** The paired host on the other end; unpaired peers are refused. */
  peerHostId: TrimmedNonEmptyString,
  path: Schema.optional(Schema.String),
});

export const BackendToHostFrame = Schema.Union([
  HostBridgeWelcomeFrame,
  HostBridgeTurnDeliverFrame,
  HostBridgeTurnInterruptFrame,
  HostBridgeCheckpointRequestFrame,
  HostBridgePromptAnswerFrame,
  HostBridgeEnvOpenFrame,
  HostBridgeEnvFrame,
  HostBridgeEnvCloseFrame,
  HostBridgeHostsPairedFrame,
  HostBridgePingFrame,
  HostBridgePongFrame,
]);
export type BackendToHostFrame = typeof BackendToHostFrame.Type;

export const decodeBackendToHostFrame = Schema.decodeUnknownEffect(
  Schema.fromJsonString(BackendToHostFrame),
);
export const encodeHostToBackendFrame = Schema.encodeEffect(
  Schema.fromJsonString(HostToBackendFrame),
);
