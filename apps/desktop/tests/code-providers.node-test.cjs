const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

function providerFixture({ missing = false } = {}) {
  let cancelled = false;
  let launch;
  const sent = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.connected = true;
  child.send = (message, callback) => {
    sent.push(message);
    callback?.();
  };
  const sourcePath = path.join(__dirname, "../src/code-providers.cjs");
  const sourceRequire = createRequire(sourcePath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    module,
    __dirname: path.dirname(sourcePath),
    process,
    require: (name) => {
      if (name === "./local-task.cjs")
        return {
          spawnLocalTask: (command, args, options) => {
            launch = { command, args, options };
            return child;
          },
          wasLocalTaskCancelled: () => cancelled,
        };
      if (name === "node:fs")
        return {
          ...fs,
          existsSync: (file) => !missing || !file.endsWith("desktop-provider-worker.mjs"),
        };
      return sourceRequire(name);
    },
  });
  return {
    child,
    sent,
    launch: () => launch,
    start: module.exports.startProvider,
    cancel: () => {
      cancelled = true;
      launch.options.onCancel();
    },
  };
}

for (const provider of ["codex", "claude", "cursor", "grok"]) {
  test(`${provider} uses the bundled adapter worker and resumes its native session`, async () => {
    const f = providerFixture();
    const events = [];
    const text = [];
    const run = f.start(provider, "Read the project", "/tmp/fixture", (chunk) => text.push(chunk), {
      sessionId: "local-session",
      resumeCursor: { threadId: "native-session" },
      stateDir: "/tmp/private-state",
      onEvent: (event) => events.push(event),
    });
    assert.match(f.launch().args[0], /provider-runtime.*desktop-provider-worker\.mjs$/);
    assert.equal(f.launch().options.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(f.sent[0].provider, provider);
    assert.equal(f.sent[0].session.resumeCursor.threadId, "native-session");
    const event = {
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: "Ditto ✓ café" },
    };
    f.child.emit("message", { type: "event", event, live: true });
    f.child.emit("message", {
      type: "event",
      event: {
        type: "content.delta",
        payload: { streamKind: "reasoning_text", delta: "reasoning" },
      },
    });
    f.child.emit("message", {
      type: "result",
      result: { cancelled: false, resumeCursor: { next: true } },
    });
    f.child.emit("close", 0);
    assert.equal((await run.result).text, "Ditto ✓ café");
    assert.equal(events.length, 2);
    assert.equal(text.join(""), "Ditto ✓ café");
  });
}

test("permission requests default to denial when no UI handler is available", async () => {
  const f = providerFixture();
  const run = f.start("grok", "Task", "/tmp/fixture", () => {});
  f.child.emit("message", { type: "approval", event: { requestId: "approval-1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.sent.at(-1).decision, "decline");
  f.child.emit("message", { type: "result", result: {} });
  f.child.emit("close", 0);
  await run.result;
});

test("cancellation uses the adapter interrupt channel and retains partial text", async () => {
  const f = providerFixture();
  const run = f.start("codex", "Task", "/tmp/fixture", () => {});
  f.child.emit("message", {
    type: "event",
    live: true,
    event: { type: "content.delta", payload: { streamKind: "assistant_text", delta: "Partial" } },
  });
  f.cancel();
  assert.equal(f.sent.at(-1).type, "cancel");
  f.child.emit("close", 143);
  assert.equal((await run.result).text, "Partial");
  assert.equal((await run.result).cancelled, true);
});

test("a worker exit without a terminal result is an error even with exit code zero", async () => {
  const f = providerFixture();
  const run = f.start("claude", "Task", "/tmp/fixture", () => {});
  f.child.stderr.end("Authentication expired for résumé");
  f.child.emit("close", 0);
  await assert.rejects(run.result, /Authentication expired for résumé/);
});

test("missing adapter bundles never fall back to the old plain-text CLI path", () => {
  const f = providerFixture({ missing: true });
  assert.throws(
    () => f.start("cursor", "Task", "/tmp/fixture", () => {}),
    /Coding runtime is missing/,
  );
  assert.equal(f.launch(), undefined);
});
