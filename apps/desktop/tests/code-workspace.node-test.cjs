const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../src/memory.cjs");
const { DesktopTerminal } = require("../src/terminal.cjs");

test("Code pinning and archiving persist for a whole conversation without losing turns", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ditto-code-threads-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  let store = new MemoryStore(folder);
  t.after(() => store.close());
  const first = store.startPiRun(folder, "First question", "pi", "conversation-one");
  store.finishPiRun(first, "done", "First answer");
  for (let i = 0; i < 24; i++) {
    const run = store.startPiRun(folder, `Follow-up ${i}`, "pi", "conversation-one");
    store.finishPiRun(run, "done", `Answer ${i}`);
  }
  const other = store.startPiRun(folder, "Independent CLI task", "codex");
  store.finishPiRun(other, "done", "CLI answer");
  assert.equal(store.codeThreads().length, 2);
  const id = "session:conversation-one";
  store.updateCodeThread(id, { pinned: true });
  assert.equal(store.codeThreads()[0].title, "First question");
  store.updateCodeThread(id, { archived: true });
  store.close();
  store = new MemoryStore(folder);
  const thread = store.codeThreads().find((thread) => thread.threadId === id);
  assert.equal(thread.pinned, 1);
  assert.equal(thread.archived, 1);
  assert.equal(
    store.codeThreadRuns(id).length,
    25,
    "history must not be truncated by the recent-20 run list",
  );
  assert.equal(store.codeThreadRuns(id)[0].response, "First answer");
  store.updateCodeThread(id, { archived: false });
  assert.equal(store.codeThreads()[0].pinned, 1, "restoring preserves pinning");
  assert.equal(store.codeThreads()[0].archived, 0);
  assert.equal(store.codeThreadRuns(`run:${other}`)[0].response, "CLI answer");
  assert.throws(() => store.updateCodeThread("session:missing", { pinned: true }), /not found/);
  assert.throws(() => store.updateCodeThread(id, { pinned: "yes", archived: false }), /Invalid/);
});

test("local terminal runs a real PTY in an isolated workspace and reattaches without restarting", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ditto-code-terminal-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  let output = "";
  let resolveOutput;
  let rejectOutput;
  const receipt = new Promise((resolve, reject) => {
    resolveOutput = resolve;
    rejectOutput = reject;
  });
  const terminal = new DesktopTerminal({
    onEvent(event) {
      if (event.type === "data") {
        output += event.data;
        if (output.includes("DITTO_TERMINAL_RECEIPT")) resolveOutput();
      }
      if (event.type === "exit" && !output.includes("DITTO_TERMINAL_RECEIPT"))
        rejectOutput(new Error("Shell exited before receipt"));
    },
  });
  t.after(() => terminal.closeAll());
  const initial = terminal.open("session:qa", cwd);
  assert.equal(initial.cwd, cwd);
  const child = terminal.sessions.get("session:qa").child;
  assert.equal(terminal.open("session:qa", os.tmpdir()).cwd, cwd);
  assert.equal(terminal.sessions.get("session:qa").child, child);
  terminal.resize("session:qa", 100, 30);
  // Split the marker so echoing the command cannot satisfy the receipt.
  terminal.write("session:qa", "test -t 0 && printf 'DITTO_%s_RECEIPT\\n' TERMINAL; pwd\r");
  const timeout = setTimeout(() => rejectOutput(new Error("PTY did not produce a receipt")), 8000);
  t.after(() => clearTimeout(timeout));
  await receipt;
  assert.ok(output.includes("DITTO_TERMINAL_RECEIPT"));
  assert.throws(() => terminal.write("session:qa", "x".repeat(65537)), /Invalid/);
  assert.throws(() => terminal.resize("session:qa", 0, 30), /Invalid/);
  terminal.close("session:qa");
  assert.equal(terminal.sessions.size, 0);
  assert.throws(() => terminal.write("session:qa", "echo nope"), /Open/);
});
