import * as NodeCrypto from "node:crypto";
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

export function acquireDevLauncherLock({
  desktopRoot,
  temporaryDirectory = NodeOS.tmpdir(),
  processId = process.pid,
  isProcessAlive = processIsAlive,
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
  const readOwner = () => {
    try {
      return Number.parseInt(NodeFS.readFileSync(lockPath, "utf8"), 10);
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
      return Number.NaN;
    }
  };
  const installOwnedLock = () => {
    const descriptor = NodeFS.openSync(lockPath, "wx", 0o600);
    try {
      NodeFS.writeFileSync(descriptor, `${processId}\n`, "utf8");
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
        if (readOwner() === processId) NodeFS.unlinkSync(lockPath);
      } catch (cause) {
        if (cause?.code !== "ENOENT") throw cause;
      }
    },
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (NodeFS.existsSync(reclaimPath)) return unavailable(readOwner());
      installOwnedLock();
      if (!NodeFS.existsSync(reclaimPath)) return ownedResult();
      if (readOwner() === processId) NodeFS.unlinkSync(lockPath);
      continue;
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      const ownerPid = readOwner();
      if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
        return unavailable(ownerPid);
      }

      afterStaleOwnerDetected?.({ lockPath, ownerPid });
      let reclaimDescriptor;
      try {
        reclaimDescriptor = NodeFS.openSync(reclaimPath, "wx", 0o600);
      } catch (reclaimCause) {
        if (reclaimCause?.code !== "EEXIST") throw reclaimCause;
        return unavailable(readOwner());
      }

      let reclaimResult;
      let reclaimError;
      try {
        const currentOwnerPid = readOwner();
        if (
          Number.isInteger(currentOwnerPid) &&
          currentOwnerPid > 0 &&
          isProcessAlive(currentOwnerPid)
        ) {
          reclaimResult = unavailable(currentOwnerPid);
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
            reclaimResult = unavailable(readOwner());
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
