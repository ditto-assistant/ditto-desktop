const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { sandboxProfile } = require("../src/pi-sandbox.cjs");

test(
  "Pi can write in its project but cannot write to another local folder",
  { skip: os.platform() !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec") },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-pi-boundary-"));
    const workspace = path.join(root, "project");
    const agentDir = path.join(root, "agent");
    const tempDir = path.join(root, "temp");
    const outside = path.join(root, "outside");
    for (const folder of [workspace, agentDir, tempDir, outside]) fs.mkdirSync(folder);
    try {
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          sandboxProfile(workspace, agentDir, tempDir),
          "/bin/sh",
          "-c",
          'printf allowed > "$PROJECT_DIR/inside"; printf denied > "$OUTSIDE_DIR/escaped"',
        ],
        { encoding: "utf8", env: { ...process.env, PROJECT_DIR: workspace, OUTSIDE_DIR: outside } },
      );
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(path.join(workspace, "inside"), "utf8"), "allowed");
      assert.equal(fs.existsSync(path.join(outside, "escaped")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "the task sandbox cannot signal an unrelated process",
  { skip: os.platform() !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec") },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-signal-boundary-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outside = spawn("/bin/sleep", ["10"], { stdio: "ignore" });
    t.after(async () => {
      if (outside.exitCode !== null || outside.signalCode !== null) return;
      const closed = once(outside, "close");
      outside.kill("SIGTERM");
      await closed;
    });
    await once(outside, "spawn");
    const result = spawnSync(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        sandboxProfile(root, root, root),
        process.execPath,
        "-e",
        `try {process.kill(${outside.pid}, 'SIGTERM'); process.exitCode=1;} catch(error) {console.log(error.code);}`,
      ],
      { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /EPERM/);
    assert.equal(outside.exitCode, null);
    assert.equal(outside.signalCode, null);
  },
);

test(
  "the sandbox lets the coding runtime stop its own detached tool group",
  { skip: os.platform() !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec") },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-stop-boundary-"));
    try {
      const script = `
        const {spawn} = require('node:child_process');
        const child = spawn('/bin/sleep', ['2'], {detached:true, stdio:['ignore','pipe','pipe']});
        child.on('spawn', () => {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch(error) { console.error(error.code); process.exitCode=1; }
        });
        child.on('close', (code, signal) => console.log(signal || code));
      `;
      const result = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", sandboxProfile(root, root, root), process.execPath, "-e", script],
        {
          encoding: "utf8",
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /SIGKILL/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
