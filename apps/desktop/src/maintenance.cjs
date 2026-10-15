const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { binaryFor } = require("./code-providers.cjs");

const PACKAGES = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  grok: "@xai-official/grok",
};
const NAMES = {
  pi: "Ditto Code",
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor Agent",
  grok: "Grok",
};
const processEnv = () => ({
  ...process.env,
  PATH: [
    path.join(os.homedir(), ".local/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.PATH || "",
  ].join(":"),
});

// Resolve ownership from the executable's real path. Never replace a vendor
// app's bundled binary or turn an unknown installation into an npm install.
function updatePlan(provider, binary) {
  if (!Object.hasOwn(NAMES, provider)) throw new Error("Unsupported coding engine.");
  if (provider === "pi")
    return { supported: false, detail: "Ditto Code updates with Ditto Desktop." };
  if (!binary || !fs.existsSync(binary))
    return { supported: false, detail: "Not installed on this Mac." };
  const real = fs.realpathSync(binary);
  if (
    real.startsWith(path.resolve(__dirname, "..") + path.sep) ||
    real.includes("/channel-sidecars/")
  ) {
    return { supported: false, detail: "This engine updates with Ditto Desktop." };
  }
  if (real.includes(".app/Contents/"))
    return { supported: false, detail: "Update the app that installed this engine." };
  const pkg = PACKAGES[provider];
  if (pkg) {
    const segment = `/lib/node_modules/${pkg}/`;
    const at = real.lastIndexOf(segment);
    if (at > 0 && !real.slice(0, at).includes("/node_modules/")) {
      const prefix = real.slice(0, at);
      const npm = path.join(prefix, "bin/npm");
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(prefix, "lib/node_modules", pkg, "package.json"), "utf8"),
        );
        if (manifest.name === pkg && fs.existsSync(npm))
          return {
            supported: true,
            detail: "Managed by npm.",
            executable: npm,
            args: ["install", "-g", "--prefix", prefix, `--allow-scripts=${pkg}`, `${pkg}@latest`],
            lock: `npm:${prefix}`,
          };
      } catch {
        /* Ownership must be verifiable. */
      }
    }
  }
  const brew = /^(\/opt\/homebrew|\/usr\/local)\/(Cellar|Caskroom)\/([a-z0-9@._-]+)\/[^/]+\//.exec(
    real,
  );
  if (brew && fs.existsSync(path.join(brew[1], "bin/brew")))
    return {
      supported: true,
      detail: "Managed by Homebrew.",
      executable: path.join(brew[1], "bin/brew"),
      args: ["upgrade", ...(brew[2] === "Caskroom" ? ["--cask"] : []), brew[3]],
      lock: `brew:${brew[1]}`,
    };
  const home = os.homedir();
  if (
    (provider === "cursor" &&
      real.startsWith(path.join(home, ".local/share/cursor-agent/versions") + "/")) ||
    (provider === "claude" &&
      real.startsWith(path.join(home, ".local/share/claude/versions") + "/")) ||
    (provider === "codex" && real.includes("/packages/standalone/"))
  ) {
    return {
      supported: true,
      detail: "Managed by the engine’s updater.",
      executable: binary,
      args: ["update"],
      lock: provider,
    };
  }
  return { supported: false, detail: "Update this installation through its original installer." };
}

function runCommand(executable, args, { timeoutMs = 300000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, {
      cwd: os.homedir(),
      env: processEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let expired = false;
    const append = (chunk) => {
      output = (output + chunk.toString().replace(/\x1b\[[0-9;]*m/g, "")).slice(-10000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let killTimer;
    const timer = setTimeout(() => {
      expired = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      killTimer.unref();
    }, timeoutMs);
    const clear = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
    };
    child.once("error", (error) => {
      clear();
      reject(error);
    });
    child.once("close", (code) => {
      clear();
      if (expired)
        reject(new Error("The update timed out. Check the installation before retrying."));
      else if (code !== 0)
        reject(
          new Error(
            `The engine updater exited with code ${code}.${output.trim() ? `\n${output.trim()}` : ""}`,
          ),
        );
      else resolve(output.trim());
    });
  });
}

class EngineMaintenance {
  constructor({
    busy = () => false,
    resolveBinary = binaryFor,
    run = runCommand,
    onStatus = () => {},
  } = {}) {
    this.busy = busy;
    this.resolveBinary = resolveBinary;
    this.run = run;
    this.onStatus = onStatus;
    this.active = null;
  }
  async status() {
    const engines = await Promise.all(
      Object.entries(NAMES).map(async ([id, name]) => {
        const binary = id === "pi" ? null : this.resolveBinary(id);
        const plan = updatePlan(id, binary);
        let version =
          id === "pi"
            ? require("../package.json").dependencies["@earendil-works/pi-coding-agent"]
            : null;
        if (binary) {
          try {
            version = (await this.run(binary, ["--version"], { timeoutMs: 8000 })).slice(0, 180);
          } catch {
            /* Show installation status if version inspection fails. */
          }
        }
        return {
          id,
          name,
          installed: id === "pi" || Boolean(binary),
          version,
          updatable: plan.supported,
          detail: plan.detail,
        };
      }),
    );
    return { engines, updating: this.active, busy: this.busy() };
  }
  async update(provider) {
    if (!Object.hasOwn(NAMES, provider)) throw new Error("Unsupported coding engine.");
    if (this.active || this.busy())
      throw new Error("Wait for active coding tasks and updates to finish first.");
    const plan = updatePlan(provider, provider === "pi" ? null : this.resolveBinary(provider));
    if (!plan.supported) throw new Error(plan.detail);
    this.active = provider;
    this.onStatus({ provider, updating: true, detail: `Updating ${NAMES[provider]}…` });
    try {
      await this.run(plan.executable, plan.args);
      const status = await this.status();
      const engine = status.engines.find((item) => item.id === provider);
      this.onStatus({
        provider,
        updating: false,
        detail: `${NAMES[provider]} update finished.`,
        version: engine.version,
      });
      return engine;
    } catch (error) {
      this.onStatus({ provider, updating: false, detail: error.message });
      throw error;
    } finally {
      this.active = null;
    }
  }
}

module.exports = { updatePlan, EngineMaintenance };
