const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnLocalTask, cancelLocalTask } = require("./local-task.cjs");

const CLI_SCRIPT = path.join(
  path.dirname(require.resolve("@heyditto/cli/package.json")),
  "dist",
  "cli.js",
);
const MAX_OUTPUT = 2 * 1024 * 1024;

function cliEnvironment(key, stateDir) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    DITTO_API_KEY: key,
    DITTO_CONFIG_DIR: stateDir || path.join(os.tmpdir(), "ditto-desktop-cli-test"),
  };
}

function cliAvailable() {
  return fs.existsSync(CLI_SCRIPT);
}

function runCli(args, { key, cwd, stateDir, timeoutMs = 120000, onProgress = () => {} }) {
  if (!cliAvailable()) throw new Error("Ditto Teleport is not bundled in this app.");
  const child = spawnLocalTask(process.execPath, [CLI_SCRIPT, ...args], {
    cwd,
    env: cliEnvironment(key, stateDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      cancelLocalTask(child);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT);
    });
    child.stderr.on("data", (chunk) => {
      const part = chunk.toString();
      stderr = (stderr + part).slice(-8000);
      onProgress(part.slice(-500));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (expired) reject(new Error("Ditto operation timed out."));
      else if (code !== 0) reject(new Error(stderr.trim() || `Ditto exited with code ${code}.`));
      else resolve(stdout.trim());
    });
  });
}

class RemoteHost {
  constructor(onStatus, stateDir) {
    this.onStatus = onStatus;
    this.stateDir = stateDir;
    this.child = null;
    this.state = { running: false, detail: "Remote Control is off." };
  }

  status() {
    return this.state;
  }

  start(provider, { key, cwd, endpoint }) {
    if (!["codex", "claude", "grok"].includes(provider))
      throw new Error("Choose Codex, Claude Code, or Grok for Remote Control.");
    if (!cliAvailable()) throw new Error("Ditto Remote Control is not bundled in this app.");
    if (this.child) throw new Error("Remote Control is already running.");
    if (
      endpoint !== undefined &&
      (typeof endpoint !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(endpoint))
    ) {
      throw new Error("Choose a Ditto endpoint.");
    }
    const child = spawnLocalTask(
      process.execPath,
      [CLI_SCRIPT, provider, "--headless", ...(endpoint ? ["--endpoint", endpoint] : [])],
      {
        cwd,
        env: cliEnvironment(key, this.stateDir),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.state = { running: true, provider, detail: "Connecting this Mac to Ditto…" };
    this.onStatus(this.state);
    let recent = "";
    const report = (chunk) => {
      recent = (recent + chunk.toString()).slice(-4000);
      const line = recent.split("\n").at(-2) || recent.trim();
      if (/remote control on|backend not reachable/i.test(line)) {
        this.state = { running: true, provider, detail: line.slice(0, 250) };
        this.onStatus(this.state);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", report);
    child.stderr.on("data", report);
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.state = { running: false, detail: error.message };
      this.onStatus(this.state);
    });
    child.once("close", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.state = {
        running: false,
        detail:
          code === 0
            ? "Remote Control stopped."
            : (recent.trim().split("\n").at(-1) || `Remote Control stopped (${code}).`).slice(
                0,
                350,
              ),
      };
      this.onStatus(this.state);
    });
    return this.state;
  }

  stop() {
    if (this.child) cancelLocalTask(this.child);
    return { ...this.state, detail: this.child ? "Stopping Remote Control…" : this.state.detail };
  }
}

module.exports = { cliAvailable, runCli, RemoteHost };
