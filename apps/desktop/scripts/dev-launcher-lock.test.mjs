import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "vite-plus/test";

import { acquireDevLauncherLock, resolveDevLauncherLockPath } from "./dev-launcher-lock.mjs";

describe("desktop development launcher ownership", () => {
  it("allows one owner and releases only its own lock", () => {
    const temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lock-test-"));
    const input = {
      desktopRoot: "/repo/apps/desktop",
      temporaryDirectory,
      processId: process.pid,
    };

    try {
      const first = acquireDevLauncherLock(input);
      const second = acquireDevLauncherLock(input);
      assert.isTrue(first.acquired);
      assert.isFalse(second.acquired);
      assert.equal(second.ownerPid, process.pid);

      first.release();
      const replacement = acquireDevLauncherLock(input);
      assert.isTrue(replacement.acquired);
      replacement.release();
    } finally {
      NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("reclaims a stale owner", () => {
    const temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lock-test-"));
    const desktopRoot = "/repo/apps/desktop-stale";
    const lockPath = resolveDevLauncherLockPath(desktopRoot, temporaryDirectory);
    NodeFS.writeFileSync(lockPath, "999999\n", "utf8");

    try {
      const lock = acquireDevLauncherLock({
        desktopRoot,
        temporaryDirectory,
        processId: process.pid,
        isProcessAlive: () => false,
      });
      assert.isTrue(lock.acquired);
      lock.release();
    } finally {
      NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("does not delete a replacement owner while reclaiming a stale lock", () => {
    const temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lock-test-"));
    const desktopRoot = "/repo/apps/desktop-reclaim-race";
    const lockPath = resolveDevLauncherLockPath(desktopRoot, temporaryDirectory);
    const replacementPid = 424_242;
    NodeFS.writeFileSync(lockPath, "999999\n", "utf8");

    try {
      const lock = acquireDevLauncherLock({
        desktopRoot,
        temporaryDirectory,
        processId: process.pid,
        isProcessAlive: (pid) => pid === replacementPid,
        getProcessIdentity: (pid) => (pid === replacementPid ? "replacement-start" : "test-start"),
        afterStaleOwnerDetected: () => {
          NodeFS.unlinkSync(lockPath);
          NodeFS.writeFileSync(
            lockPath,
            `${JSON.stringify({ pid: replacementPid, identity: "replacement-start" })}\n`,
            "utf8",
          );
        },
      });
      assert.isFalse(lock.acquired);
      assert.equal(lock.ownerPid, replacementPid);
      assert.include(NodeFS.readFileSync(lockPath, "utf8"), '"identity":"replacement-start"');
    } finally {
      NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("reclaims stale PID reuse and abandoned reclaim markers", () => {
    const temporaryDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lock-test-"));
    const desktopRoot = "/repo/apps/desktop-pid-reuse";
    const lockPath = resolveDevLauncherLockPath(desktopRoot, temporaryDirectory);
    NodeFS.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 77, identity: "old-start" })}\n`,
      "utf8",
    );
    NodeFS.writeFileSync(
      `${lockPath}.reclaim`,
      `${JSON.stringify({ pid: 88, identity: "dead-reclaimer" })}\n`,
      "utf8",
    );

    try {
      const lock = acquireDevLauncherLock({
        desktopRoot,
        temporaryDirectory,
        processId: process.pid,
        isProcessAlive: (pid) => pid === 77 || pid === process.pid,
        getProcessIdentity: (pid) => (pid === 77 ? "new-start" : "test-start"),
      });
      assert.isTrue(lock.acquired);
      lock.release();
    } finally {
      NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
