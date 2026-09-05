/**
 * Ditto Teleport and Ditto account contracts.
 *
 * Teleport snapshots a thread's working state (repos, working tree, harness
 * session) into a capsule stored in Ditto Cloud so it can resume on another
 * machine or inside a Ditto Code cloud job. The desktop drives the capture
 * server-side; the client only sees typed progress. The Ditto account methods
 * store the `ditto_mcp_` key obtained through the device-code flow in the
 * server's secret store, never in renderer storage.
 *
 * @module teleport
 */
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

export const DittoAccountStatus = Schema.Struct({
  linked: Schema.Boolean,
  /** Last four characters of the linked key, for display only. */
  keyHint: Schema.optional(Schema.String),
  apiBaseUrl: Schema.optional(Schema.String),
});
export type DittoAccountStatus = typeof DittoAccountStatus.Type;

export const DittoAccountLinkInput = Schema.Struct({
  /** A `ditto_mcp_` key minted by the Ditto device-code flow. */
  apiKey: Schema.String.check(Schema.isMinLength(16)),
  apiBaseUrl: Schema.String.check(Schema.isMinLength(8)),
});
export type DittoAccountLinkInput = typeof DittoAccountLinkInput.Type;

export class DittoAccountError extends Schema.TaggedErrorClass<DittoAccountError>()(
  "DittoAccountError",
  {
    message: Schema.String,
  },
) {}

export const TeleportHarness = Schema.Literals(["claude-code", "codex"]);
export type TeleportHarness = typeof TeleportHarness.Type;

export const TeleportThreadInput = Schema.Struct({
  threadId: ThreadId,
  /** The thread's working directory: its worktree, else the project root. */
  cwd: Schema.String.check(Schema.isMinLength(1)),
  /** Provider driving the thread ("claude", "codex", …); decides the harness state to carry. */
  providerName: Schema.NullOr(Schema.String),
  /** Display name for a new capsule; defaults to the root directory name. */
  capsuleName: Schema.optional(Schema.String),
});
export type TeleportThreadInput = typeof TeleportThreadInput.Type;

export const TeleportProgressStage = Schema.Literals([
  "preparing",
  "bundling",
  "packing",
  "negotiating",
  "uploading",
  "committing",
]);
export type TeleportProgressStage = typeof TeleportProgressStage.Type;

export const TeleportCapsuleSummary = Schema.Struct({
  capsuleId: Schema.String,
  capsuleName: Schema.String,
  generation: Schema.Number,
  bytes: Schema.Number,
  chunks: Schema.Number,
  /** Chunks the backend already held, so the upload skipped them. */
  dedupedChunks: Schema.Number,
  harness: Schema.NullOr(TeleportHarness),
  harnessSessionId: Schema.NullOr(Schema.String),
});
export type TeleportCapsuleSummary = typeof TeleportCapsuleSummary.Type;

export const TeleportProgressEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: TeleportProgressStage,
    detail: Schema.optional(Schema.String),
    bytesUploaded: Schema.optional(Schema.Number),
    bytesTotal: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    capsule: TeleportCapsuleSummary,
  }),
]);
export type TeleportProgressEvent = typeof TeleportProgressEvent.Type;

export class TeleportError extends Schema.TaggedErrorClass<TeleportError>()("TeleportError", {
  message: Schema.String,
}) {}

export const TeleportLaunchCloudSessionInput = Schema.Struct({
  capsuleId: Schema.String,
  harness: TeleportHarness,
});
export type TeleportLaunchCloudSessionInput = typeof TeleportLaunchCloudSessionInput.Type;

export const TeleportCloudSession = Schema.Struct({
  jobId: Schema.String,
  threadId: Schema.String,
  agentId: Schema.String,
  /** Where to follow the session in the Ditto app. */
  url: Schema.String,
});
export type TeleportCloudSession = typeof TeleportCloudSession.Type;

/** Maps a desktop provider name onto the harness a capsule can resume. */
export function teleportHarnessForProvider(
  providerName: string | null | undefined,
): TeleportHarness | null {
  switch (providerName) {
    case "claude":
      return "claude-code";
    case "codex":
      return "codex";
    default:
      return null;
  }
}
