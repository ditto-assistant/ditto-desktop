import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export function resolveDevLauncherLockPath(desktopRoot, temporaryDirectory = NodeOS.tmpdir()) {
  const identity = NodeCrypto.createHash("sha256").update(desktopRoot).digest("hex").slice(0, 16);
  return NodePath.join(temporaryDirectory, `t3code-dev-electron-${identity}.lock`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause?.code === "EPERM";
  }
}

function processIdentity(pid) {
  try {
    return NodeChildProcess.execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function acquireDevLauncherLock({
  desktopRoot,
  temporaryDirectory = NodeOS.tmpdir(),
  processId = process.pid,
  isProcessAlive = processIsAlive,
  getProcessIdentity = processIdentity,
  afterStaleOwnerDetected,
}) {
  const lockPath = resolveDevLauncherLockPath(desktopRoot, temporaryDirectory);
  const reclaimPath = `${lockPath}.reclaim`;

  const unavailable = (ownerPid) => ({
    acquired: false,
    ownerPid,
    lockPath,
    release() {},
  });
  const currentIdentity = getProcessIdentity(processId);
  const readOwner = (path = lockPath) => {
    try {
      const value = NodeFS.readFileSync(path, "utf8");
      try {
        const parsed = JSON.parse(value);
        return { pid: parsed.pid, identity: parsed.identity };
      } catch {
        return { pid: Number.parseInt(value, 10), identity: undefined };
      }
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
      return undefined;
    }
  };
  const ownerIsAlive = (owner) =>
    owner !== undefined &&
    Number.isInteger(owner.pid) &&
    owner.pid > 0 &&
    isProcessAlive(owner.pid) &&
    (owner.identity === undefined || owner.identity === getProcessIdentity(owner.pid));
  const ownerPayload = () => `${JSON.stringify({ pid: processId, identity: currentIdentity })}\n`;
  const installOwnedLock = () => {
    const descriptor = NodeFS.openSync(lockPath, "wx", 0o600);
    try {
      NodeFS.writeFileSync(descriptor, ownerPayload(), "utf8");
    } finally {
      NodeFS.closeSync(descriptor);
    }
  };
  const ownedResult = () => ({
    acquired: true,
    ownerPid: processId,
    lockPath,
    release() {
      try {
        const owner = readOwner();
        if (owner?.pid === processId && owner.identity === currentIdentity)
          NodeFS.unlinkSync(lockPath);
      } catch (cause) {
        if (cause?.code !== "ENOENT") throw cause;
      }
    },
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const reclaimOwner = readOwner(reclaimPath);
      if (reclaimOwner !== undefined) {
        if (ownerIsAlive(reclaimOwner)) return unavailable(readOwner()?.pid);
        try {
          NodeFS.unlinkSync(reclaimPath);
        } catch (cause) {
          if (cause?.code !== "ENOENT") throw cause;
        }
      }
      installOwnedLock();
      if (!NodeFS.existsSync(reclaimPath)) return ownedResult();
      const installedOwner = readOwner();
      if (installedOwner?.pid === processId && installedOwner.identity === currentIdentity) {
        NodeFS.unlinkSync(lockPath);
      }
      continue;
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      const owner = readOwner();
      if (ownerIsAlive(owner)) {
        return unavailable(owner.pid);
      }

      afterStaleOwnerDetected?.({ lockPath, ownerPid: owner?.pid });
      let reclaimDescriptor;
      try {
        reclaimDescriptor = NodeFS.openSync(reclaimPath, "wx", 0o600);
        NodeFS.writeFileSync(reclaimDescriptor, ownerPayload(), "utf8");
      } catch (reclaimCause) {
        if (reclaimCause?.code !== "EEXIST") throw reclaimCause;
        return unavailable(readOwner()?.pid);
      }

      let reclaimResult;
      let reclaimError;
      try {
        const currentOwner = readOwner();
        if (ownerIsAlive(currentOwner)) {
          reclaimResult = unavailable(currentOwner.pid);
        } else {
          try {
            NodeFS.unlinkSync(lockPath);
          } catch (unlinkCause) {
            if (unlinkCause?.code !== "ENOENT") throw unlinkCause;
          }
          try {
            installOwnedLock();
            reclaimResult = ownedResult();
          } catch (installCause) {
            if (installCause?.code !== "EEXIST") throw installCause;
            reclaimResult = unavailable(readOwner()?.pid);
          }
        }
      } catch (cause) {
        reclaimError = cause;
      }
      NodeFS.closeSync(reclaimDescriptor);
      try {
        NodeFS.unlinkSync(reclaimPath);
      } catch (unlinkCause) {
        if (unlinkCause?.code !== "ENOENT") throw unlinkCause;
      }
      if (reclaimError !== undefined) throw reclaimError;
      return reclaimResult;
    }
  }

  return { acquired: false, ownerPid: undefined, lockPath, release() {} };
}
