const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const { codeComposerOverlay } = require("../scripts/desktop-code-bridge.cjs");
const sourcePath = path.join(__dirname, "../web/ditto-app/src/components/code/codeComposer.ts");

test(
  "the shared web composer dispatches local tasks and isolates local and cloud drafts",
  { skip: !fs.existsSync(sourcePath) },
  async () => {
    const ts = require("../web/ditto-app/node_modules/typescript");
    const source = fs.readFileSync(
      path.join(__dirname, "../web/ditto-app/src/components/code/codeComposer.ts"),
      "utf8",
    );
    const patched = codeComposerOverlay(source).replaceAll(
      "import.meta.env.VITE_DITTO_DESKTOP",
      "true",
    );
    const code = ts.transpileModule(patched, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const handlers = {};
    const context = {
      exports: {},
      require: (name) => {
        assert.equal(name, "solid-js");
        return {
          createSignal: (value) => [() => value, (next) => (value = next)],
          createMemo: (fn) => fn,
        };
      },
      window: { addEventListener: (type, fn) => (handlers[type] = fn) },
    };
    vm.runInNewContext(code, context);
    const api = context.exports;
    api.setCodeTaskDraft("cloud draft");
    handlers["ditto-desktop-execution-mode"]({ detail: { local: true } });
    assert.equal(api.codeTaskDraft(), "");
    api.setCodeTaskDraft("local draft");
    context.dittoDesktopStartCode = async () => ({ status: "started", jobId: "local-id" });
    api.registerCodeTaskStarter(async () => ({ status: "started", jobId: "cloud-id" }));
    assert.equal((await api.startCodeTaskFromComposer({ prompt: "task" })).jobId, "local-id");
    handlers["ditto-desktop-execution-mode"]({ detail: { local: false } });
    assert.equal(api.codeTaskDraft(), "cloud draft");
    context.dittoDesktopStartCode = async () => null;
    assert.equal((await api.startCodeTaskFromComposer({ prompt: "task" })).jobId, "cloud-id");
    handlers["ditto-desktop-execution-mode"]({ detail: { local: true } });
    assert.equal(api.codeTaskDraft(), "local draft");
  },
);

for (const provider of ["pi", "claude"]) {
  test(`${provider} task failures show the provider reason and release the composer`, async () => {
    const source = fs.readFileSync(path.join(__dirname, "../src/desktop-shell.js"), "utf8");
    const body = acorn.parse(source, { ecmaVersion: "latest" }).body[0].expression.callee.body.body;
    const run = body.find(
      (node) => node.type === "FunctionDeclaration" && node.id.name === "runLocalTask",
    );
    const formatter = body
      .filter((node) => node.type === "VariableDeclaration")
      .flatMap((node) => node.declarations)
      .find((node) => node.id.name === "desktopError").init;
    const controls = new Map();
    const control = (selector) => {
      if (!controls.has(selector)) controls.set(selector, {});
      return controls.get(selector);
    };
    control("#dl-provider").value = provider;
    const reason = "Failed to authenticate: OAuth session expired and could not be refreshed";
    const fail = async () => {
      const method = provider === "pi" ? "ditto:chat" : "ditto:run-provider";
      throw new Error(`Error invoking remote method '${method}': Error: ${reason}`);
    };
    const context = {
      $: control,
      activeCodeThread: null,
      localSessionId: "qa-session",
      running: false,
      codeWorkspaceBlocked: () => false,
      syncCodeTools() {},
      addLocalTurn() {},
      mountLocalCode() {},
      refresh: async () => {},
      window: { ditto: { chat: fail, runProvider: fail } },
      show: (selector, message) => {
        control(selector).textContent = message;
      },
    };
    context.desktopError = vm.runInNewContext(source.slice(formatter.start, formatter.end));
    const dispatch = vm.runInNewContext(`(${source.slice(run.start, run.end)})`, context);
    await dispatch("Review this disposable fixture without editing it.");
    assert.equal(control("#dl-context").textContent, reason);
    assert.equal(context.running, false);
    assert.equal(control("#dl-provider").disabled, false);
    assert.equal(control("#dl-run").disabled, false);
    assert.equal(control("#dl-cancel").hidden, true);
  });
}

test("a missing project blocks both composers and direct task dispatch before resolving a fallback workspace", async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/desktop-shell.js"), "utf8");
  const body = acorn.parse(source, { ecmaVersion: "latest" }).body[0].expression.callee.body.body;
  const calls = [];
  const context = {
    activePanel: "Local",
    running: false,
    codeWorkspaceUnavailable: true,
    unavailableCodeWorkspaceMessage: "Choose a working folder",
    workspaceReady: false,
    window: { ditto: { workspace: async () => calls.push("fallback") } },
    $: () => ({ value: "Synthetic prompt" }),
    show: (_target, message) => calls.push(message),
  };
  for (const name of ["codeWorkspaceBlocked", "runLocalTask"]) {
    const node = body.find((node) => node.type === "FunctionDeclaration" && node.id.name === name);
    context[name] = vm.runInNewContext(`(${source.slice(node.start, node.end)})`, context);
  }
  const shared = body.find(
    (node) =>
      node.type === "ExpressionStatement" &&
      node.expression.type === "AssignmentExpression" &&
      node.expression.left.property?.name === "dittoDesktopStartCode",
  ).expression.right;
  const legacy = body.find(
    (node) =>
      node.type === "ExpressionStatement" &&
      node.expression.type === "CallExpression" &&
      node.expression.callee.object?.arguments?.[0]?.value === "#dl-chat-form" &&
      node.expression.arguments[0]?.value === "submit",
  ).expression.arguments[1];
  const dispatch = vm.runInNewContext(`(${source.slice(shared.start, shared.end)})`, context);
  assert.equal((await dispatch({ prompt: "Synthetic prompt" })).status, "blocked");
  await context.runLocalTask("Synthetic prompt");
  const submit = vm.runInNewContext(`(${source.slice(legacy.start, legacy.end)})`, context);
  await submit({ preventDefault() {} });
  assert.deepEqual(calls, Array(3).fill("Choose a working folder"));
  assert.equal(context.running, false);
  assert.equal(context.workspaceReady, false);
});
