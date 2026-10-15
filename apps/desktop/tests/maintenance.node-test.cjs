const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const childProcess = require("node:child_process");
const { updatePlan, EngineMaintenance } = require("../src/maintenance.cjs");

test("updates the actual npm owner and leaves vendor bundles and unknown installs alone", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ditto-engine-")));
  try {
    const pkg = path.join(root, "lib/node_modules/@anthropic-ai/claude-code");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-code" }),
    );
    const binary = path.join(pkg, "bin/claude");
    fs.writeFileSync(binary, "");
    fs.writeFileSync(path.join(root, "bin/npm"), "");
    const plan = updatePlan("claude", binary);
    assert.equal(plan.supported, true);
    assert.equal(plan.executable, path.join(root, "bin/npm"));
    assert.deepEqual(plan.args, [
      "install",
      "-g",
      "--prefix",
      root,
      "--allow-scripts=@anthropic-ai/claude-code",
      "@anthropic-ai/claude-code@latest",
    ]);
    const vendor = path.join(root, "ChatGPT.app/Contents/MacOS/codex");
    fs.mkdirSync(path.dirname(vendor), { recursive: true });
    fs.writeFileSync(vendor, "");
    assert.equal(updatePlan("codex", vendor).supported, false);
    const unknown = path.join(root, "codex");
    fs.writeFileSync(unknown, "");
    assert.equal(updatePlan("codex", unknown).supported, false);
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "wrong-package" }));
    assert.equal(updatePlan("claude", binary).supported, false);
    assert.throws(() => updatePlan("bash", "/bin/bash"), /Unsupported/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses engine updates while coding or another update is active", async () => {
  let launched = false;
  const maintenance = new EngineMaintenance({
    busy: () => true,
    run: async () => {
      launched = true;
    },
  });
  await assert.rejects(maintenance.update("claude"), /Wait for active/);
  assert.equal(launched, false);
  maintenance.busy = () => false;
  maintenance.active = "cursor";
  await assert.rejects(maintenance.update("claude"), /Wait for active/);
  assert.equal(launched, false);
});

test("a timed out engine updater drains its owned descendants and releases maintenance", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ditto-updater-timeout-")));
  const pkg = path.join(root, "lib/node_modules/@anthropic-ai/claude-code");
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-code" }),
  );
  const binary = path.join(pkg, "bin/claude");
  fs.writeFileSync(binary, "");
  const script = path.join(root, "updater.cjs");
  fs.writeFileSync(
    script,
    `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"
    ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.once('message', () => console.log('UPDATER_READY:' + child.pid));
    setInterval(() => {}, 1000);
  `,
  );
  const npm = path.join(root, "bin/npm");
  fs.writeFileSync(npm, `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`, { mode: 0o700 });
  const sourcePath = path.join(__dirname, "../src/maintenance.cjs");
  const load = createRequire(sourcePath);
  const ready = Promise.withResolvers();
  let child;
  let descendant;
  let expire;
  const capture =
    (spawn) =>
    (...args) => {
      child = spawn(...args);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /UPDATER_READY:(\d+)/.exec(output);
        if (match) {
          descendant = Number(match[1]);
          ready.resolve();
        }
      });
      child.once("error", ready.reject);
      child.once("close", () => ready.reject(new Error("Updater exited before readiness.")));
      return child;
    };
  const target = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(sourcePath, "utf8"),
    {
      module: target,
      __dirname: path.dirname(sourcePath),
      process,
      require(name) {
        if (name === "node:child_process")
          return { ...childProcess, spawn: capture(childProcess.spawn) };
        if (name === "./local-task.cjs") {
          const tasks = load(name);
          return { ...tasks, spawnLocalTask: capture(tasks.spawnLocalTask) };
        }
        return load(name);
      },
      setTimeout(callback, delay) {
        if (delay === 300000) {
          expire = callback;
          return {};
        }
        return setTimeout(callback, delay);
      },
      clearTimeout,
    },
    { filename: sourcePath },
  );
  const maintenance = new target.exports.EngineMaintenance({
    resolveBinary: (provider) => (provider === "claude" ? binary : null),
  });
  let rescued = false;
  const rescue = () => {
    rescued = true;
    if (descendant) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {}
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const watchdog = setTimeout(rescue, 6500);
  t.after(() => {
    clearTimeout(watchdog);
    rescue();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const completion = maintenance.update("claude").then(
    () => ({ unexpected: true }),
    (error) => ({ error }),
  );
  await ready.promise;
  assert.equal(maintenance.active, "claude");
  expire();
  const result = await completion;
  clearTimeout(watchdog);
  assert.equal(rescued, false, "Updater descendants required rescue instead of production cleanup");
  assert.match(result.error?.message || "", /timed out/);
  assert.equal(maintenance.active, null);
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
  descendant = null;
  // Retry through the real updater and version-inspection paths after cleanup.
  fs.writeFileSync(npm, "#!/bin/sh\nprintf 'QA_UPDATE_FINISHED\\n'\n");
  fs.writeFileSync(binary, "#!/bin/sh\nprintf 'Claude Code QA 1.0\\n'\n", { mode: 0o700 });
  fs.chmodSync(binary, 0o700);
  const recovered = await maintenance.update("claude");
  assert.equal(recovered.version, "Claude Code QA 1.0");
  assert.equal(recovered.updatable, true);
  assert.equal(maintenance.active, null);
});
