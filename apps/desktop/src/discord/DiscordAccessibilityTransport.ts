// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - This adapter owns one bounded native helper subprocess; its Promise interface is intentionally mockable without leaking process services into IPC contracts.
import type {
  DiscordAccessibilityReplyInput,
  DiscordAccessibilityReplyOutcome,
  DiscordAccessibilityReplyResult,
  DiscordAccessibilitySnapshotInput,
  DiscordAccessibilitySnapshotResult,
  DiscordAccessibilityStatus,
} from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import type {
  AppAutomationDescriptor,
  AppAutomationTarget,
  AppScopedAutomationAdapter,
} from "../appAutomation/AppScopedAutomationAdapter.ts";

const DISCORD_SNOWFLAKE = /^\d{15,24}$/;
const ACTION_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 3_000;
const SNAPSHOT_TIMEOUT_MS = 3_000;
const MAX_RECEIPTS = 256;

type HelperCommand =
  | { readonly command: "status"; readonly prompt: boolean }
  | {
      readonly command: "snapshot";
      readonly accountId: string;
      readonly conversationId: string;
      readonly expectedTitle: string;
      readonly maxMessages: number;
    }
  | {
      readonly command: "execute";
      readonly actionId: string;
      readonly origin: DiscordAccessibilityReplyInput["origin"];
      readonly mode: DiscordAccessibilityReplyInput["mode"];
      readonly deepLink: string;
      readonly expectedTitle: string;
      readonly text: string;
      readonly timeoutMs: number;
    };

export interface DiscordAccessibilityHelperRunner {
  run(
    command: HelperCommand,
    timeoutMs: number,
    onSpawn?: (cancel: () => void) => void,
  ): Promise<unknown>;
}

export const DISCORD_ACCESSIBILITY_DESCRIPTOR = {
  adapterId: "discord-accessibility",
  service: "discord",
  bundleId: "com.hnc.Discord",
  capabilities: {
    semanticObservation: "supported",
    semanticDraft: "supported",
    semanticCommit: "best_effort",
    cursorless: "supported",
    background: "best_effort",
    lockedSession: "unsupported",
    interventionDetection: "best_effort",
  },
} as const satisfies AppAutomationDescriptor;

function discordTarget(
  input: DiscordAccessibilityReplyInput | DiscordAccessibilitySnapshotInput,
): AppAutomationTarget | null {
  if (!DISCORD_SNOWFLAKE.test(input.conversationId)) return null;
  const scope = "containerId" in input ? (input.containerId ?? "@me") : "@me";
  if (scope !== "@me" && !DISCORD_SNOWFLAKE.test(scope)) return null;
  if (input.conversationTitle.trim().length === 0 || input.conversationTitle.length > 200)
    return null;
  return {
    adapterId: DISCORD_ACCESSIBILITY_DESCRIPTOR.adapterId,
    bundleId: DISCORD_ACCESSIBILITY_DESCRIPTOR.bundleId,
    accountId: input.accountId,
    conversationId: input.conversationId,
    ...(scope === "@me" ? {} : { containerId: scope }),
    expectedTitle: input.conversationTitle,
  };
}

function discordDeepLink(target: AppAutomationTarget): string {
  return `discord://-/channels/${target.containerId ?? "@me"}/${target.conversationId}`;
}

function fallbackResult(
  input: DiscordAccessibilityReplyInput,
  outcome: DiscordAccessibilityReplyOutcome,
  detail: string,
  startedAt = new Date().toISOString(),
): DiscordAccessibilityReplyResult {
  return {
    actionId: input.actionId,
    origin: input.origin,
    mode: input.mode,
    outcome,
    permission: outcome === "permission_required" ? "not_granted" : "unavailable",
    startedAt,
    completedAt: new Date().toISOString(),
    detail,
    sent: false,
    draftPrepared: false,
    duplicate: false,
  };
}

function isReplyResult(
  value: unknown,
  input: DiscordAccessibilityReplyInput,
): value is DiscordAccessibilityReplyResult {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    row.actionId === input.actionId &&
    row.origin === input.origin &&
    row.mode === input.mode &&
    typeof row.outcome === "string" &&
    typeof row.permission === "string" &&
    typeof row.startedAt === "string" &&
    typeof row.completedAt === "string" &&
    typeof row.detail === "string" &&
    typeof row.sent === "boolean" &&
    typeof row.draftPrepared === "boolean" &&
    typeof row.duplicate === "boolean"
  );
}

function isStatus(value: unknown): value is DiscordAccessibilityStatus {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.available === "boolean" &&
    (row.permission === "granted" ||
      row.permission === "not_granted" ||
      row.permission === "unavailable") &&
    typeof row.detail === "string"
  );
}

function snapshotFailure(
  input: DiscordAccessibilitySnapshotInput,
  detail: string,
  permission: DiscordAccessibilitySnapshotResult["permission"] = "unavailable",
): DiscordAccessibilitySnapshotResult {
  return {
    accountId: input.accountId,
    conversationId: input.conversationId,
    permission,
    observedAt: new Date().toISOString(),
    targetVerified: false,
    truncated: false,
    detail,
    messages: [],
  };
}

function isSnapshotResult(
  value: unknown,
  input: DiscordAccessibilitySnapshotInput,
): value is DiscordAccessibilitySnapshotResult {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  if (
    row.accountId !== input.accountId ||
    row.conversationId !== input.conversationId ||
    (row.permission !== "granted" &&
      row.permission !== "not_granted" &&
      row.permission !== "unavailable") ||
    typeof row.observedAt !== "string" ||
    typeof row.targetVerified !== "boolean" ||
    typeof row.truncated !== "boolean" ||
    typeof row.detail !== "string" ||
    !Array.isArray(row.messages)
  ) {
    return false;
  }
  return row.messages.every((message) => {
    if (typeof message !== "object" || message === null) return false;
    const item = message as Record<string, unknown>;
    return (
      typeof item.id === "string" &&
      typeof item.author === "string" &&
      (item.timestamp === undefined || typeof item.timestamp === "string") &&
      (item.sentAt === undefined || typeof item.sentAt === "string") &&
      typeof item.content === "string" &&
      item.provenance === "discord_accessibility_live" &&
      Array.isArray(item.attachments) &&
      item.attachments.every((attachment) => {
        if (typeof attachment !== "object" || attachment === null) return false;
        const candidate = attachment as Record<string, unknown>;
        return (
          typeof candidate.indicator === "string" &&
          (candidate.url === undefined || typeof candidate.url === "string")
        );
      })
    );
  });
}

export class NativeDiscordAccessibilityHelper implements DiscordAccessibilityHelperRunner {
  readonly helperPath: string;

  constructor(helperPath: string) {
    this.helperPath = helperPath;
  }

  run(
    command: HelperCommand,
    timeoutMs: number,
    onSpawn?: (cancel: () => void) => void,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!NodeFS.existsSync(this.helperPath)) {
        reject(new Error("The Discord Accessibility helper is not bundled in this build."));
        return;
      }

      const child = NodeChildProcess.spawn(this.helperPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const cancel = () => {
        if (!settled) child.kill("SIGTERM");
      };
      onSpawn?.(cancel);
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new Error("Discord Accessibility action timed out.")));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (cause) => finish(() => reject(cause)));
      child.once("exit", (code, signal) => {
        finish(() => {
          if (signal === "SIGTERM") {
            reject(new Error("Discord Accessibility action was cancelled."));
            return;
          }
          if (code !== 0) {
            reject(
              new Error(stderr.trim() || `Discord Accessibility helper exited ${String(code)}.`),
            );
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("Discord Accessibility helper returned an invalid response."));
          }
        });
      });
      child.stdin.end(JSON.stringify(command));
    });
  }
}

export class DiscordAccessibilityTransport implements AppScopedAutomationAdapter<
  DiscordAccessibilityStatus,
  DiscordAccessibilitySnapshotInput,
  DiscordAccessibilitySnapshotResult,
  DiscordAccessibilityReplyInput,
  DiscordAccessibilityReplyResult
> {
  readonly descriptor = DISCORD_ACCESSIBILITY_DESCRIPTOR;
  readonly #inFlight = new Map<string, () => void>();
  readonly #receipts = new Map<string, DiscordAccessibilityReplyResult>();
  readonly platform: NodeJS.Platform;
  readonly runner: DiscordAccessibilityHelperRunner;

  constructor(platform: NodeJS.Platform, runner: DiscordAccessibilityHelperRunner) {
    this.platform = platform;
    this.runner = runner;
  }

  resolveTarget(
    input: DiscordAccessibilityReplyInput | DiscordAccessibilitySnapshotInput,
  ): AppAutomationTarget | null {
    return discordTarget(input);
  }

  async status(prompt = false): Promise<DiscordAccessibilityStatus> {
    if (this.platform !== "darwin") {
      return {
        available: false,
        permission: "unavailable",
        detail: "Discord Accessibility replies are available on macOS only.",
      };
    }
    try {
      const value = await this.runner.run({ command: "status", prompt }, STATUS_TIMEOUT_MS);
      return isStatus(value)
        ? value
        : {
            available: false,
            permission: "unavailable",
            detail: "Discord Accessibility helper returned an invalid status.",
          };
    } catch (cause) {
      return {
        available: false,
        permission: "unavailable",
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  async snapshot(
    input: DiscordAccessibilitySnapshotInput,
  ): Promise<DiscordAccessibilitySnapshotResult> {
    if (this.platform !== "darwin") {
      return snapshotFailure(input, "Discord live snapshots require macOS.");
    }
    const maxMessages = Math.min(Math.max(input.maxMessages ?? 100, 1), 200);
    if (this.resolveTarget(input) === null) {
      return snapshotFailure(input, "The Discord snapshot target is invalid.");
    }
    try {
      const value = await this.runner.run(
        {
          command: "snapshot",
          accountId: input.accountId,
          conversationId: input.conversationId,
          expectedTitle: input.conversationTitle,
          maxMessages,
        },
        SNAPSHOT_TIMEOUT_MS,
      );
      return isSnapshotResult(value, input)
        ? value
        : snapshotFailure(input, "Discord Accessibility helper returned an invalid snapshot.");
    } catch (cause) {
      return snapshotFailure(input, cause instanceof Error ? cause.message : String(cause));
    }
  }

  async execute(input: DiscordAccessibilityReplyInput): Promise<DiscordAccessibilityReplyResult> {
    const previous = this.#receipts.get(input.actionId);
    if (previous) return { ...previous, duplicate: true };
    const startedAt = new Date().toISOString();
    if (this.platform !== "darwin") {
      return this.#remember(
        fallbackResult(
          input,
          "unsupported",
          "Discord Accessibility replies require macOS.",
          startedAt,
        ),
      );
    }
    const target = this.resolveTarget(input);
    if (target === null || input.text.trim().length === 0) {
      return this.#remember(
        fallbackResult(input, "failed", "The Discord target or message is invalid.", startedAt),
      );
    }
    if (this.#inFlight.has(input.actionId)) {
      return fallbackResult(input, "failed", "This reply action is already running.", startedAt);
    }

    try {
      const value = await this.runner.run(
        {
          command: "execute",
          actionId: input.actionId,
          origin: input.origin,
          mode: input.mode,
          deepLink: discordDeepLink(target),
          expectedTitle: input.conversationTitle,
          text: input.text,
          timeoutMs: ACTION_TIMEOUT_MS,
        },
        ACTION_TIMEOUT_MS + 1_000,
        (cancel) => this.#inFlight.set(input.actionId, cancel),
      );
      if (!isReplyResult(value, input)) {
        return this.#remember(
          fallbackResult(
            input,
            "failed",
            "Discord Accessibility helper returned an invalid receipt.",
            startedAt,
          ),
        );
      }
      return this.#remember(value);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const outcome = detail.includes("cancelled")
        ? "cancelled"
        : detail.includes("timed out")
          ? "timed_out"
          : "failed";
      return this.#remember(fallbackResult(input, outcome, detail, startedAt));
    } finally {
      this.#inFlight.delete(input.actionId);
    }
  }

  perform(input: DiscordAccessibilityReplyInput): Promise<DiscordAccessibilityReplyResult> {
    return this.execute(input);
  }

  cancel(actionId: string): boolean {
    const cancel = this.#inFlight.get(actionId);
    if (!cancel) return false;
    cancel();
    return true;
  }

  #remember(result: DiscordAccessibilityReplyResult): DiscordAccessibilityReplyResult {
    this.#receipts.set(result.actionId, result);
    while (this.#receipts.size > MAX_RECEIPTS) {
      const oldest = this.#receipts.keys().next().value;
      if (oldest === undefined) break;
      this.#receipts.delete(oldest);
    }
    return result;
  }
}
