const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SANDBOX = "/usr/bin/sandbox-exec";

function sandboxProfile(workspace, agentDir, tempDir) {
  const writable = [workspace, agentDir, tempDir]
    .map((folder) => `(subpath ${JSON.stringify(fs.realpathSync(folder))})`)
    .join(" ");
  return `(version 1)
(deny default)
(allow file-read*)
(allow file-write* ${writable})
(allow process*)
(allow sysctl-read)
(allow mach-lookup)
(allow network*)`;
}

function spawnSandboxedPi(
  executable,
  script,
  args,
  { workspace, agentDir, dataDir, extraEnv = {} },
) {
  if (os.platform() !== "darwin" || !fs.existsSync(SANDBOX)) {
    throw new Error("The local Ditto Code filesystem sandbox is unavailable on this Mac.");
  }
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const tempDir = fs.mkdtempSync(path.join(dataDir, "pi-task-"));
  const profile = sandboxProfile(workspace, agentDir, tempDir);
  const child = spawn(SANDBOX, ["-p", profile, executable, script, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PI_CODING_AGENT_DIR: agentDir,
      DITTO_CODING_AGENT_DIR: agentDir,
      ...extraEnv,
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
      XDG_CACHE_HOME: tempDir,
      npm_config_cache: tempDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("close", () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* Temporary files can be cleaned on a later run. */
    }
  });
  return child;
}

module.exports = { sandboxProfile, spawnSandboxedPi };
