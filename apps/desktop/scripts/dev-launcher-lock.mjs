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
}) {
  const lockPath = resolveDevLauncherLockPath(desktopRoot, temporaryDirectory);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = NodeFS.openSync(lockPath, "wx", 0o600);
      NodeFS.writeFileSync(descriptor, `${processId}\n`, "utf8");
      NodeFS.closeSync(descriptor);
      return {
        acquired: true,
        ownerPid: processId,
        lockPath,
        release() {
          try {
            if (Number.parseInt(NodeFS.readFileSync(lockPath, "utf8"), 10) === processId) {
              NodeFS.unlinkSync(lockPath);
            }
          } catch (cause) {
            if (cause?.code !== "ENOENT") throw cause;
          }
        },
      };
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
      let ownerPid = Number.NaN;
      try {
        ownerPid = Number.parseInt(NodeFS.readFileSync(lockPath, "utf8"), 10);
      } catch (readCause) {
        if (readCause?.code !== "ENOENT") throw readCause;
      }
      if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
        return { acquired: false, ownerPid, lockPath, release() {} };
      }
      try {
        NodeFS.unlinkSync(lockPath);
      } catch (unlinkCause) {
        if (unlinkCause?.code !== "ENOENT") throw unlinkCause;
      }
    }
  }

  return { acquired: false, ownerPid: undefined, lockPath, release() {} };
}
