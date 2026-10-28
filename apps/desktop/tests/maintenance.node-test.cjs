const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const childProcess = require("node:child_process");
const net = require("node:net");
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
      "const net = require('node:net'); process.on('SIGTERM', () => {}); const server = net.createServer(); server.listen(0, '127.0.0.1', () => process.send(server.address().port));"
    ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.once('message', port => console.log('UPDATER_READY:' + child.pid + ':' + port));
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
  let port;
  let expire;
  const capture =
    (spawn) =>
    (...args) => {
      child = spawn(...args);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const match = /UPDATER_READY:(\d+):(\d+)/.exec(output);
        if (match) {
          descendant = Number(match[1]);
          port = Number(match[2]);
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
  // Linux can retain a killed descendant as a zombie until its new parent reaps it.
  // This fixture keeps listening until killed, so refusal verifies actual cleanup.
  const socket = net.connect({ host: "127.0.0.1", port });
  t.after(() => socket.destroy());
  const outcome = await new Promise((resolve) => {
    socket.once("connect", () => resolve("connected"));
    socket.once("error", (error) => resolve(error.code));
  });
  assert.equal(outcome, "ECONNREFUSED");
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

test("engine version and update errors preserve UTF-8 across output chunks", async () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ditto-updater-utf8-")));
  const pkg = path.join(root, "lib/node_modules/@anthropic-ai/claude-code");
  try {
    fs.mkdirSync(pkg, { recursive: true });
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-code" }),
    );
    const binary = path.join(pkg, "claude");
    fs.writeFileSync(binary, "");
    fs.writeFileSync(path.join(root, "bin/npm"), "");
    const version = "Synthetic café 日本語 ✓";
    const failure = "SYNTHETIC_UPDATE_ERROR café 日本語 ✓";
    const sourcePath = path.join(__dirname, "../src/maintenance.cjs");
    const load = createRequire(sourcePath);
    const target = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(sourcePath, "utf8"),
      {
        module: target,
        __dirname: path.dirname(sourcePath),
        process,
        setTimeout,
        clearTimeout,
        require(name) {
          if (name !== "./local-task.cjs") return load(name);
          return {
            spawnLocalTask(_file, args) {
              const child = new EventEmitter();
              child.stdout = new PassThrough();
              child.stderr = new PassThrough();
              queueMicrotask(() => {
                const inspect = args[0] === "--version";
                const bytes = Buffer.from(inspect ? version : failure);
                const cut = bytes.indexOf(Buffer.from("日本語")) + 1;
                const stream = inspect ? child.stdout : child.stderr;
                stream.write(bytes.subarray(0, cut));
                stream.end(bytes.subarray(cut));
                child.emit("close", inspect ? 0 : 42);
              });
              return child;
            },
            cancelLocalTask() {},
          };
        },
      },
      { filename: sourcePath },
    );
    const events = [];
    const maintenance = new target.exports.EngineMaintenance({
      resolveBinary: (id) => (id === "claude" ? binary : null),
      onStatus: (event) => events.push(event),
    });
    assert.equal(
      (await maintenance.status()).engines.find((engine) => engine.id === "claude").version,
      version,
    );
    await assert.rejects(maintenance.update("claude"), (error) => error.message.includes(failure));
    assert.ok(events.at(-1).detail.includes(failure));
    assert.equal(maintenance.active, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
