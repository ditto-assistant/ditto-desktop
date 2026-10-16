const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { cancelLocalTask } = require("../src/local-task.cjs");

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t, provider, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-adapter-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, "bundle");
  let runtimeRoot = stage;
  const output = path.join(stage, "native/provider-runtime");
  fs.mkdirSync(output, { recursive: true });
  fs.cpSync(path.join(__dirname, "../native/provider-runtime"), output, { recursive: true });
  if (process.versions.electron) {
    const asar = await import(require.resolve("@electron/asar"));
    runtimeRoot = path.join(root, "provider.asar");
    await asar.createPackage(stage, runtimeRoot);
  }
  const bin = path.join(root, ".local/bin");
  fs.mkdirSync(bin, { recursive: true });
  const peer =
    provider === "codex"
      ? path.join(__dirname, "fixtures/codex-app-server.cjs")
      : provider === "claude"
        ? path.join(__dirname, "fixtures/claude-agent.cjs")
        : path.resolve(__dirname, "../../server/scripts/acp-mock-agent.ts");
  const log = path.join(root, "requests.ndjson");
  const exports = {
    T3_ACP_EMIT_TOOL_CALLS: "1",
    T3_ACP_EMIT_LOAD_REPLAY: "1",
    T3_ACP_REQUEST_LOG_PATH: log,
    ...env,
  };
  fs.writeFileSync(
    path.join(bin, provider === "cursor" ? "cursor-agent" : provider),
    `#!/bin/sh\n${Object.entries(exports)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      .join(
        "\n",
      )}\nexec ${shellQuote(process.execPath)} --experimental-strip-types ${shellQuote(peer)} "$@"\n`,
    { mode: 0o700 },
  );
  const sourcePath = path.join(__dirname, "../src/code-providers.cjs");
  const load = createRequire(sourcePath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), {
    module,
    process,
    __dirname: path.join(runtimeRoot, "src"),
    require: (name) => (name === "node:os" ? { ...os, homedir: () => root } : load(name)),
  });
  return { root, log, start: module.exports.startProvider };
}

for (const provider of ["codex", "claude", "cursor", "grok"]) {
  test(
    `${provider}: staged sidecar runs the native adapter and resumes its session`,
    { timeout: 15000, skip: os.platform() === "win32" },
    async (t) => {
      const f = await fixture(t, provider);
      const events = [];
      let approvals = 0;
      const start = (resumeCursor) =>
        f.start(provider, "Read the project", f.root, () => {}, {
          stateDir: path.join(f.root, "private-state"),
          sessionId: "desktop-thread",
          resumeCursor,
          onEvent: (event) => events.push(event),
          approve: async () => {
            approvals++;
            return "accept";
          },
        });
      const run = start();
      t.after(() => cancelLocalTask(run.child));
      const result = await run.result;
      assert.equal(result.cancelled, false);
      assert.equal(
        result.text,
        ["codex", "claude"].includes(provider) ? "Ditto ✓ café" : "hello from mock",
      );
      assert.ok(result.resumeCursor);
      if (["cursor", "grok"].includes(provider)) assert.ok(approvals >= 1);
      if (["cursor", "grok"].includes(provider))
        assert.ok(
          events.some(
            (event) =>
              event.type === "item.updated" && event.payload.itemType === "command_execution",
          ),
        );
      const resumed = start(result.resumeCursor);
      t.after(() => cancelLocalTask(resumed.child));
      assert.equal((await resumed.result).text, result.text);
      const requests = fs.readFileSync(f.log, "utf8");
      assert.match(
        requests,
        provider === "codex"
          ? /thread\/resume/
          : provider === "claude"
            ? /"--resume=/
            : /session\/load|session\/resume/,
      );
      assert.equal(fs.existsSync(path.join(f.root, "private-state/userdata/state.sqlite")), false);
    },
  );
}

test(
  "stopping the staged ACP worker interrupts its adapter and retains partial output",
  { timeout: 15000, skip: os.platform() === "win32" },
  async (t) => {
    const f = await fixture(t, "cursor", { T3_ACP_EMIT_CONTENT_THEN_HANG: "1" });
    let run;
    run = f.start(
      "cursor",
      "Read the project",
      f.root,
      () => {
        cancelLocalTask(run.child);
      },
      {
        stateDir: path.join(f.root, "state"),
        approve: async () => "accept",
      },
    );
    t.after(() => cancelLocalTask(run.child));
    const result = await run.result;
    assert.equal(result.cancelled, true);
    assert.ok(result.text.length > 0);
    assert.ok(result.resumeCursor);
  },
);

test(
  "structured follow-up requests fail clearly and release the adapter instead of hanging",
  { timeout: 15000, skip: os.platform() === "win32" },
  async (t) => {
    const f = await fixture(t, "cursor", {
      T3_ACP_EMIT_TOOL_CALLS: "0",
      T3_ACP_EMIT_ASK_QUESTION: "1",
    });
    const run = f.start("cursor", "Ask a follow-up", f.root, () => {}, {
      stateDir: path.join(f.root, "state"),
      approve: async () => "accept",
    });
    t.after(() => cancelLocalTask(run.child));
    await assert.rejects(run.result, /interactive answer/);
  },
);
