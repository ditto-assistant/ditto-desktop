/**
 * What the host bridge needs from the machine it runs on, independent of the
 * transport: the sessions to announce, their command catalogs, prompts the
 * harness is waiting on, and the verbs the backend can invoke. The production
 * implementation sits on t3code's orchestration engine
 * (`OrchestrationHostBridgeRuntime.ts`); tests use an in-memory one.
 *
 * @module remote/HostBridgeRuntime
 */
import type {
  HostBridgeCommand,
  HostBridgeHarness,
  HostBridgePromptKind,
  HostBridgePromptOption,
  HostBridgeSessionMode,
  HostBridgeSessionStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export interface HostBridgeSession {
  readonly sessionId: string;
  readonly harness: HostBridgeHarness;
  readonly cwd: string;
  readonly mode: HostBridgeSessionMode;
  readonly status: HostBridgeSessionStatus;
  readonly title?: string | undefined;
  readonly commands: ReadonlyArray<HostBridgeCommand>;
}

export interface HostBridgePrompt {
  readonly promptId: string;
  readonly sessionId: string;
  readonly kind: HostBridgePromptKind;
  readonly text: string;
  readonly options?: ReadonlyArray<HostBridgePromptOption> | undefined;
  readonly default?: string | undefined;
}

export type HostBridgeRuntimeEvent =
  | { readonly type: "session.upserted"; readonly session: HostBridgeSession }
  | { readonly type: "session.closed"; readonly sessionId: string }
  | { readonly type: "prompt.pending"; readonly prompt: HostBridgePrompt };

export class HostBridgeRuntimeError extends Schema.TaggedError<HostBridgeRuntimeError>()(
  "HostBridgeRuntimeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface HostBridgeRuntimeShape {
  readonly listSessions: Effect.Effect<ReadonlyArray<HostBridgeSession>>;
  /** Hot stream: session changes and prompts as they happen. */
  readonly events: Stream.Stream<HostBridgeRuntimeEvent>;
  /** Submit a user turn; `text` already carries the attached-files list. */
  readonly submitTurn: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly text: string;
  }) => Effect.Effect<void, HostBridgeRuntimeError>;
  /** v1.1: run `/name args`; resolve `unsupported` when the session's mode cannot run it. */
  readonly submitCommand: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly name: string;
    readonly args: string;
  }) => Effect.Effect<{ readonly unsupported?: string | undefined }, HostBridgeRuntimeError>;
  readonly answerPrompt: (input: {
    readonly sessionId: string | null;
    readonly promptId: string;
    readonly value: string;
  }) => Effect.Effect<void, HostBridgeRuntimeError>;
  readonly interruptTurn: (input: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => Effect.Effect<void, HostBridgeRuntimeError>;
  readonly createCheckpoint: (input: {
    readonly sessionId: string;
    readonly reason?: string | undefined;
  }) => Effect.Effect<{ readonly generation: string }, HostBridgeRuntimeError>;
}

export class HostBridgeRuntime extends Context.Service<HostBridgeRuntime, HostBridgeRuntimeShape>()(
  "t3/remote/HostBridgeRuntime",
) {}

// ---------------------------------------------------------------------------
// Pure mappings shared by the orchestration runtime and its tests.
// ---------------------------------------------------------------------------

/** Only Claude Code and Codex are remote-controllable (protocol v1.1). */
export function harnessForProvider(
  providerName: string | null | undefined,
): HostBridgeHarness | null {
  switch (providerName) {
    case "claudeAgent":
    case "claude":
    case "claude-code":
      return "claude-code";
    case "codex":
      return "codex";
    default:
      return null;
  }
}

export function sessionStatusForProvider(
  status: string | null | undefined,
  activeTurnId: string | null | undefined,
): HostBridgeSessionStatus {
  return status === "running" || (activeTurnId !== null && activeTurnId !== undefined)
    ? "running"
    : "idle";
}

/**
 * Builds the v1.1 catalog from what t3code already knows about a provider:
 * its slash commands and user-invocable skills. Everything runs through the
 * provider runtime, so nothing is TUI-only here.
 */
export function commandsFromProviderSnapshot(snapshot: {
  readonly slashCommands: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly input?: { readonly hint: string } | undefined;
  }>;
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly shortDescription?: string | undefined;
    readonly enabled: boolean;
    readonly userInvocable?: boolean | undefined;
    readonly scope?: string | undefined;
  }>;
}): ReadonlyArray<HostBridgeCommand> {
  const byName = new Map<string, HostBridgeCommand>();
  for (const command of snapshot.slashCommands) {
    const name = command.name.replace(/^\//, "");
    byName.set(name, {
      name,
      ...(command.description !== undefined ? { description: command.description } : {}),
      source: "builtin",
      ...(command.input?.hint ? { argsHint: command.input.hint } : {}),
      headless: true,
    });
  }
  for (const skill of snapshot.skills) {
    if (!skill.enabled || skill.userInvocable === false) continue;
    const description = skill.shortDescription ?? skill.description;
    byName.set(skill.name, {
      name: skill.name,
      ...(description !== undefined ? { description } : {}),
      source: skill.scope === "plugin" ? "plugin" : "skill",
      headless: true,
    });
  }
  return [...byName.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

export const PERMISSION_PROMPT_OPTIONS: ReadonlyArray<HostBridgePromptOption> = [
  { id: "accept", label: "Allow" },
  { id: "acceptForSession", label: "Allow for this session" },
  { id: "acceptAlways", label: "Always allow" },
  { id: "decline", label: "Deny" },
];

export type PromptTarget =
  | { readonly kind: "approval"; readonly requestId: string }
  | { readonly kind: "question"; readonly requestId: string };

export function promptIdFor(target: PromptTarget): string {
  return `${target.kind}:${target.requestId}`;
}

export function parsePromptId(promptId: string): PromptTarget | null {
  const separator = promptId.indexOf(":");
  if (separator <= 0) return null;
  const kind = promptId.slice(0, separator);
  const requestId = promptId.slice(separator + 1);
  if (requestId.length === 0) return null;
  if (kind === "approval" || kind === "question") return { kind, requestId };
  return null;
}

const APPROVAL_DECISIONS = new Set([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);

/** Free-text answers to a permission prompt map onto t3code's decisions; anything else denies. */
export function approvalDecisionForAnswer(
  value: string,
): "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel" {
  const trimmed = value.trim();
  if (APPROVAL_DECISIONS.has(trimmed)) {
    return trimmed as ReturnType<typeof approvalDecisionForAnswer>;
  }
  const lower = trimmed.toLowerCase();
  if (["y", "yes", "allow", "approve", "ok"].includes(lower)) return "accept";
  if (["always", "allow always"].includes(lower)) return "acceptAlways";
  return "decline";
}
