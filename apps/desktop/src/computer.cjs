const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function helperPath() {
  return process.resourcesPath &&
    fs.existsSync(path.join(process.resourcesPath, "channel-sidecars", "ditto-computer-use"))
    ? path.join(process.resourcesPath, "channel-sidecars", "ditto-computer-use")
    : path.join(__dirname, "..", "native", "bin", "ditto-computer-use");
}

function createComputerControl({ execute = execFileAsync, getHelper = helperPath } = {}) {
  let snapshot = null;
  return async function computerAction(action, ref, value) {
    if (!["status", "snapshot", "activate", "click", "set"].includes(action))
      throw new Error("Unsupported computer action.");
    if (action === "activate" && (typeof ref !== "string" || !/^[A-Za-z0-9.-]{3,180}$/.test(ref)))
      throw new Error("Choose a running app by its bundle ID.");
    if (
      ["click", "set"].includes(action) &&
      (typeof ref !== "string" || !/^w\d+(\.\d+){0,8}$/.test(ref))
    )
      throw new Error("Inspect the Mac and use a listed element reference.");
    if (action === "set" && (typeof value !== "string" || value.length > 10000))
      throw new Error("Enter shorter text.");
    const args = [
      action,
      ...(ref === undefined ? [] : [ref]),
      ...(value === undefined ? [] : [value]),
    ];
    if (["click", "set"].includes(action)) {
      const target = snapshot?.elements?.find((element) => element.ref === ref);
      if (!target)
        throw new Error("Inspect the current app before using a listed element reference.");
      args.push(
        "--expect",
        JSON.stringify({
          bundleId: snapshot.bundleId,
          pid: snapshot.pid,
          role: target.role,
          title: target.title,
          description: target.description,
        }),
      );
    }
    if (action === "activate") snapshot = null;
    const binary = getHelper();
    if (!fs.existsSync(binary)) throw new Error("Mac computer control is not bundled in this app.");
    try {
      const { stdout } = await execute(binary, args, {
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const result = JSON.parse(stdout);
      if (action === "snapshot")
        snapshot = result.bundleId && Number.isInteger(result.pid) ? result : null;
      if (
        action === "status" &&
        snapshot &&
        (snapshot.bundleId !== result.bundleId || snapshot.pid !== result.pid)
      )
        snapshot = null;
      if (["click", "set"].includes(action)) snapshot = null;
      return result;
    } catch (error) {
      let result;
      try {
        result = JSON.parse(error.stdout);
      } catch {
        /* The helper may fail before writing JSON. */
      }
      if (["click", "set", "snapshot"].includes(action)) snapshot = null;
      if (result?.error) throw new Error(result.error);
      throw error;
    }
  };
}

module.exports = { createComputerControl };
