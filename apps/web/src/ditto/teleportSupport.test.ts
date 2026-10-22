import {
  type EnvironmentThreadShell,
  threadRuntimeCanArchive,
} from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "../components/threadActionMenu.logic";
import { threadSupportsTeleport } from "./teleportSupport";

type Runtime = NonNullable<EnvironmentThreadShell["runtime"]>;

/** A thread shell as the live state carries it: driver kind in `providerName`. */
function threadWith(
  runtime: Partial<Record<keyof Runtime, unknown>> | null,
): Pick<EnvironmentThreadShell, "runtime"> {
  return { runtime: runtime as unknown as Runtime | null };
}

/** Mirrors `useThreadActionMenu`: menu state derived from the thread shell. */
function menuStateFor(thread: Pick<EnvironmentThreadShell, "runtime">): ThreadActionMenuState {
  return {
    canOperate: true,
    branch: null,
    projectFilter: null,
    isPinned: false,
    isSettled: false,
    autoSettleEnabled: true,
    isSnoozed: false,
    canSnoozeNow: true,
    isRegeneratingTitle: false,
    isRunning: !threadRuntimeCanArchive(thread.runtime),
    supports: {
      settlement: true,
      autoSettleOptOut: true,
      snooze: true,
      pinning: true,
      titleRegeneration: true,
      teleport: threadSupportsTeleport(thread),
    },
    snoozePresets: [],
  };
}

function teleportItems(thread: Pick<EnvironmentThreadShell, "runtime">) {
  return buildThreadActionMenuItems(menuStateFor(thread)).filter((item) => item.id === "teleport");
}

describe("threadSupportsTeleport", () => {
  it("offers exactly one Teleport entry for real Claude Code and Codex sessions", () => {
    const claude = threadWith({
      providerName: "claudeAgent",
      providerInstanceId: "claudeAgent",
      status: "ready",
    });
    const codex = threadWith({
      providerName: "codex",
      providerInstanceId: "codex",
      status: "ready",
    });
    const customClaude = threadWith({
      providerName: "claudeAgent",
      providerInstanceId: "claudeAgent-work",
      status: "ready",
    });

    for (const thread of [claude, codex, customClaude]) {
      expect(threadSupportsTeleport(thread)).toBe(true);
      const items = teleportItems(thread);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ label: "Teleport to Ditto Cloud", disabled: false });
    }
  });

  it("offers nothing for providers without a resumable cloud harness", () => {
    for (const providerName of ["cursor", "opencode", "grok", "ditto"]) {
      const thread = threadWith({
        providerName,
        providerInstanceId: providerName,
        status: "ready",
      });
      expect(threadSupportsTeleport(thread)).toBe(false);
      expect(teleportItems(thread)).toHaveLength(0);
    }
    expect(threadSupportsTeleport(threadWith(null))).toBe(false);
    expect(teleportItems(threadWith(null))).toHaveLength(0);
  });

  it("keeps the entry but disables it while a turn is running", () => {
    const running = threadWith({
      providerName: "claudeAgent",
      providerInstanceId: "claudeAgent",
      status: "running",
      activeRunId: "run-1",
    });
    const items = teleportItems(running);
    expect(items).toHaveLength(1);
    expect(items[0]?.disabled).toBe(true);
  });
});
