import type { ChatService } from "@t3tools/contracts";

export type AppAutomationSupport = "supported" | "best_effort" | "unsupported";

export interface AppAutomationCapabilities {
  /** Read a bounded semantic tree/state without scraping the whole desktop. */
  readonly semanticObservation: AppAutomationSupport;
  /** Set an exact draft through a semantic element handle/value. */
  readonly semanticDraft: AppAutomationSupport;
  /** Commit a previously verified draft through a semantic action. */
  readonly semanticCommit: AppAutomationSupport;
  /** Operate without moving the user's physical pointer. */
  readonly cursorless: AppAutomationSupport;
  /** Operate while the target app is not frontmost. */
  readonly background: AppAutomationSupport;
  /** Operate while the macOS login session remains locked. */
  readonly lockedSession: AppAutomationSupport;
  /** Detect target-scoped user activity and invalidate stale handles. */
  readonly interventionDetection: AppAutomationSupport;
}

export interface AppAutomationDescriptor {
  readonly adapterId: string;
  readonly service: ChatService;
  readonly bundleId: string;
  readonly capabilities: AppAutomationCapabilities;
}

/**
 * Canonical identity for one app surface. Display text is corroborating metadata,
 * never sufficient identity for a mutation.
 */
export interface AppAutomationTarget {
  readonly adapterId: string;
  readonly bundleId: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly containerId?: string;
  readonly expectedTitle: string;
}

export type AppAutomationFailureCode =
  | "target_changed"
  | "user_intervened"
  | "stale_snapshot"
  | "screen_locked"
  | "permission_denied"
  | "ambiguous_target"
  | "requires_activation"
  | "timed_out"
  | "unsupported"
  | "failed";

export interface AppAutomationFailure {
  readonly code: AppAutomationFailureCode;
  readonly detail: string;
  readonly retryable: boolean;
}

export interface AppAutomationRequestContext {
  readonly requestId: string;
  readonly requestedAt: string;
  readonly deadlineMs: number;
  readonly focusPolicy: "never_activate" | "allow_activation";
  /** Opaque revision from the last semantic snapshot. */
  readonly expectedRevision?: string;
}

/**
 * The common desktop boundary used by concrete app adapters. The type parameters
 * preserve each app's rich snapshot/action receipts while lifecycle and safety
 * semantics stay uniform.
 */
export interface AppScopedAutomationAdapter<Status, SnapshotInput, Snapshot, ActionInput, Receipt> {
  readonly descriptor: AppAutomationDescriptor;
  resolveTarget(input: SnapshotInput | ActionInput): AppAutomationTarget | null;
  status(prompt?: boolean): Promise<Status>;
  snapshot(input: SnapshotInput): Promise<Snapshot>;
  perform(input: ActionInput): Promise<Receipt>;
  cancel(requestId: string): boolean;
}

export function appAutomationTargetKey(target: AppAutomationTarget): string {
  return [
    target.adapterId,
    target.bundleId,
    target.accountId,
    target.containerId ?? "@me",
    target.conversationId,
  ].join(":");
}
