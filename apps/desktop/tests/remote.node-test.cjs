const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { execFileSync } = childProcess;
const { createRequire } = require("node:module");
const vm = require("node:vm");
const { cliAvailable, runCli, RemoteHost } = require("../src/remote.cjs");

test("bundled Ditto Teleport previews a local repo without uploading it", async () => {
  assert.equal(cliAvailable(), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-teleport-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    fs.writeFileSync(path.join(root, "README.md"), "Local test project");
    const plan = JSON.parse(
      await runCli(["teleport", "plan", root, "--json"], {
        key: "test-key-unused-for-plan",
        cwd: root,
        stateDir: path.join(root, "cli-state"),
        timeoutMs: 30000,
      }),
    );
    assert.equal(plan.root, fs.realpathSync(root));
    assert.equal(plan.repos.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Remote Control rejects unsupported engines before launching a process", () => {
  const host = new RemoteHost(() => {});
  assert.throws(() => host.start("pi", { key: "test", cwd: os.tmpdir() }), /Choose Codex/);
  assert.equal(host.status().running, false);
});

for (const operation of ["timeout", "stop"]) {
  test(`remote CLI ${operation} terminates an unresponsive owned process`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-remote-shutdown-"));
    fs.mkdirSync(path.join(root, "dist"));
    fs.writeFileSync(
      path.join(root, "dist/cli.js"),
      `
      process.on("SIGTERM", () => {});
      process.stderr.write("remote control on\\n");
      setInterval(() => {}, 1000);
    `,
    );
    const sourcePath = path.join(__dirname, "../src/remote.cjs");
    const load = createRequire(sourcePath);
    let child;
    let expire;
    const ready = Promise.withResolvers();
    const capture =
      (spawn) =>
      (...args) => {
        child = spawn(...args);
        let text = "";
        child.stderr.on("data", (chunk) => {
          text += chunk.toString();
          if (text.includes("remote control on")) ready.resolve();
        });
        child.once("error", ready.reject);
        child.once("close", () => ready.reject(new Error("Fixture stopped before readiness.")));
        return child;
      };
    const fixtureRequire = (name) => {
      if (name === "node:child_process")
        return { ...childProcess, spawn: capture(childProcess.spawn) };
      if (name === "./local-task.cjs") {
        const tasks = load(name);
        return { ...tasks, spawnLocalTask: capture(tasks.spawnLocalTask) };
      }
      return load(name);
    };
    fixtureRequire.resolve = (name) =>
      name === "@heyditto/cli/package.json" ? path.join(root, "package.json") : load.resolve(name);
    const target = { exports: {} };
    vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
      module: target,
      __dirname: path.dirname(sourcePath),
      process,
      require: fixtureRequire,
      setTimeout: (callback) => {
        expire = callback;
        return {};
      },
      clearTimeout: () => {},
    });
    let rescued = false;
    let watchdog;
    try {
      let completion;
      if (operation === "timeout") {
        completion = target.exports
          .runCli(["teleport", "plan"], { key: "synthetic", cwd: root, stateDir: root })
          .then(
            () => ({ unexpected: true }),
            (error) => ({ error }),
          );
      } else {
        const host = new target.exports.RemoteHost(() => {}, root);
        host.start("codex", { key: "synthetic", cwd: root });
        completion = new Promise((resolve) => child.once("close", () => resolve(host.status())));
        await ready.promise;
        host.stop();
      }
      await ready.promise;
      if (operation === "timeout") expire();
      // Failure-only rescue keeps a broken baseline from leaking our fixture process.
      watchdog = setTimeout(() => {
        rescued = true;
        child.kill("SIGKILL");
      }, 4500);
      const result = await completion;
      assert.equal(
        rescued,
        false,
        "shutdown required the test watchdog instead of its own escalation",
      );
      if (operation === "timeout") assert.match(result.error?.message || "", /timed out/);
      else assert.equal(result.running, false);
    } finally {
      clearTimeout(watchdog);
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
