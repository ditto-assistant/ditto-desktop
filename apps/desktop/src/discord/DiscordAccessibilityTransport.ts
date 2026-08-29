// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - This adapter owns one bounded native helper subprocess; its Promise interface is intentionally mockable without leaking process services into IPC contracts.
import type {
  DiscordAccessibilityReplyInput,
  DiscordAccessibilityReplyOutcome,
  DiscordAccessibilityReplyResult,
  DiscordAccessibilityStatus,
} from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

const DISCORD_SNOWFLAKE = /^\d{15,24}$/;
const ACTION_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 3_000;
const MAX_RECEIPTS = 256;

type HelperCommand =
  | { readonly command: "status"; readonly prompt: boolean }
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

function discordDeepLink(input: DiscordAccessibilityReplyInput): string | null {
  if (!DISCORD_SNOWFLAKE.test(input.conversationId)) return null;
  const scope = input.containerId ?? "@me";
  if (scope !== "@me" && !DISCORD_SNOWFLAKE.test(scope)) return null;
  return `discord://-/channels/${scope}/${input.conversationId}`;
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

export class DiscordAccessibilityTransport {
  readonly #inFlight = new Map<string, () => void>();
  readonly #receipts = new Map<string, DiscordAccessibilityReplyResult>();
  readonly platform: NodeJS.Platform;
  readonly runner: DiscordAccessibilityHelperRunner;

  constructor(platform: NodeJS.Platform, runner: DiscordAccessibilityHelperRunner) {
    this.platform = platform;
    this.runner = runner;
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
    const deepLink = discordDeepLink(input);
    if (deepLink === null || input.text.trim().length === 0) {
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
          deepLink,
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
