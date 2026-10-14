const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

function providerFixture() {
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
      if (name === "node:child_process") return { spawn: () => child };
      if (name === "node:fs") return { ...fs, existsSync: () => true };
      return sourceRequire(name);
    },
  });
  return { child, start: module.exports.startProvider };
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
