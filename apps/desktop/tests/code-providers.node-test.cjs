const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

function providerFixture() {
  let cancelled = false;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  const sourcePath = path.join(__dirname, "../src/code-providers.cjs");
  const sourceRequire = createRequire(sourcePath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    module,
    __dirname: path.dirname(sourcePath),
    process,
    require: (name) => {
      if (name === "./local-task.cjs")
        return { spawnLocalTask: () => child, wasLocalTaskCancelled: () => cancelled };
      if (name === "node:child_process") return { spawn: () => child };
      if (name === "node:fs") return { ...fs, existsSync: () => true };
      return sourceRequire(name);
    },
  });
  return { child, start: module.exports.startProvider, cancel: () => (cancelled = true) };
}

test("plain provider output preserves Unicode across stdout pipe chunks", async () => {
  const { child, start } = providerFixture();
  const deltas = [];
  const run = start("claude", "Disposable task", "/tmp/fixture", (text) => deltas.push(text));
  const bytes = Buffer.from("Ditto ✓ 🦜 café\n");
  // Pipes can split at every byte, including inside a multi-byte character.
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  child.stdout.end();
  child.emit("close", 0);
  assert.equal((await run.result).text, "Ditto ✓ 🦜 café");
  assert.equal(deltas.join(""), "Ditto ✓ 🦜 café\n");
});

test("provider failure details preserve Unicode across stderr pipe chunks", async () => {
  const { child, start } = providerFixture();
  const run = start("cursor", "Disposable task", "/tmp/fixture", () => {});
  for (const byte of Buffer.from("Cannot open résumé.txt")) child.stderr.write(Buffer.from([byte]));
  child.stderr.end();
  child.emit("close", 1);
  await assert.rejects(run.result, /Cannot open résumé\.txt/);
});

test("intentional provider cancellation retains partial output without exposing diagnostics", async () => {
  const { child, start, cancel } = providerFixture();
  const run = start("claude", "Disposable task", "/tmp/fixture", () => {});
  child.stdout.end("Partial answer");
  child.stderr.end("private runtime diagnostic");
  cancel();
  child.stdin.emit("error", new Error("write EPIPE"));
  child.emit("close", 143);
  const result = await run.result;
  assert.equal(result.cancelled, true);
  assert.equal(result.text, "Partial answer");
});

for (const exitCode of [0, 1]) {
  test(`early CLI exit ${exitCode} during a large prompt reports failure without crashing Desktop`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-provider-pipe-"));
    try {
      const bin = path.join(root, ".local/bin");
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(
        path.join(bin, "claude"),
        `#!/usr/bin/env node\n${exitCode ? 'process.stderr.write("Fixture CLI authentication unavailable");' : ""} process.exit(${exitCode});\n`,
        { mode: 0o700 },
      );
      const source = path.join(__dirname, "../src/code-providers.cjs");
      const worker = `
      const fs = require("node:fs");
      const vm = require("node:vm");
      const path = require("node:path");
      const os = require("node:os");
      const source = process.argv[1];
      const root = process.argv[2];
      const load = require("node:module").createRequire(source);
      const target = { exports: {} };
      vm.runInNewContext(fs.readFileSync(source, "utf8"), {
        module: target, __dirname: path.dirname(source), process,
        require: name => name === "node:os" ? { ...os, homedir: () => root } : load(name),
      });
      const run = target.exports.startProvider("claude", "q".repeat(2 * 1024 * 1024), root, () => {});
      run.result.then(() => { process.exitCode = 2; }, error => { process.stdout.write(JSON.stringify({ error: error.message })); });
    `;
      const { stdout } = await promisify(execFile)(process.execPath, ["-e", worker, source, root], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: 10000,
        maxBuffer: 100000,
      });
      assert.match(
        JSON.parse(stdout).error,
        exitCode
          ? /Fixture CLI authentication unavailable/
          : /Could not send the task to Claude Code/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
