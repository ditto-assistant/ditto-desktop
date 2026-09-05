import { describe, expect, it } from "vite-plus/test";

import {
  formatTeleportBytes,
  reduceTeleportDialog,
  type TeleportDialogState,
  type TeleportDialogTarget,
} from "./teleportDialog";
import type { EnvironmentId, TeleportCapsuleSummary } from "@t3tools/contracts";

const target: TeleportDialogTarget = {
  environmentId: "env-1" as EnvironmentId,
  threadTitle: "Fix the login flow",
};

const capsule: TeleportCapsuleSummary = {
  capsuleId: "cap-1",
  capsuleName: "backend",
  generation: 3,
  bytes: 4096,
  chunks: 2,
  dedupedChunks: 1,
  harness: "claude-code",
  harnessSessionId: "sess-1",
};

describe("reduceTeleportDialog", () => {
  it("tracks progress then completion", () => {
    let state: TeleportDialogState = { status: "idle" };
    state = reduceTeleportDialog(state, { type: "begin", target });
    expect(state).toMatchObject({ status: "running", stage: "preparing" });
    state = reduceTeleportDialog(state, {
      type: "event",
      event: { type: "progress", stage: "uploading", bytesUploaded: 10, bytesTotal: 100 },
    });
    expect(state).toMatchObject({ status: "running", stage: "uploading", bytesUploaded: 10, bytesTotal: 100 });
    // A later frame without totals keeps the known total so the bar does not jump.
    state = reduceTeleportDialog(state, {
      type: "event",
      event: { type: "progress", stage: "uploading", bytesUploaded: 50 },
    });
    expect(state).toMatchObject({ bytesUploaded: 50, bytesTotal: 100 });
    state = reduceTeleportDialog(state, { type: "event", event: { type: "complete", capsule } });
    expect(state).toEqual({ status: "complete", target, capsule });
  });

  it("fails only while running and closes through the closing phase", () => {
    const running = reduceTeleportDialog({ status: "idle" }, { type: "begin", target });
    const failed = reduceTeleportDialog(running, { type: "fail", message: "boom" });
    expect(failed).toEqual({ status: "failed", target, message: "boom" });
    expect(reduceTeleportDialog(failed, { type: "fail", message: "again" })).toBe(failed);
    const closing = reduceTeleportDialog(failed, { type: "close" });
    expect(closing).toEqual({ status: "closing", view: failed });
    expect(reduceTeleportDialog(closing, { type: "closed" })).toEqual({ status: "idle" });
  });

  it("ignores progress that arrives after completion", () => {
    const complete: TeleportDialogState = { status: "complete", target, capsule };
    expect(
      reduceTeleportDialog(complete, {
        type: "event",
        event: { type: "progress", stage: "uploading" },
      }),
    ).toBe(complete);
  });
});

describe("formatTeleportBytes", () => {
  it("picks a readable unit", () => {
    expect(formatTeleportBytes(512)).toBe("512 B");
    expect(formatTeleportBytes(1536)).toBe("1.5 KB");
    expect(formatTeleportBytes(24 * 1024 * 1024)).toBe("24 MB");
  });
});
