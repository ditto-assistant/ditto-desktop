const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");

const source = fs.readFileSync(path.join(__dirname, "../src/desktop-shell.js"), "utf8");
const body = acorn.parse(source, { ecmaVersion: "latest" }).body[0].expression.callee.body.body;
const sync = body.find(
  (node) => node.type === "FunctionDeclaration" && node.id.name === "syncCodeTools",
);

function toolsHarness(tool) {
  const calls = [];
  const context = {
    activePanel: "Local",
    codeTool: tool,
    key: "session:first",
    codeTerminalKey: () => context.key,
    codePaneVisible: false,
    codePaneLastTool: null,
    codePaneLastThread: null,
    codePaneWidth: 440,
    codeTools: { querySelectorAll: () => [] },
    codePane: {},
    paneTabs: { children: [] },
    terminalPanel: {},
    browserPage: {},
    activityPanel: {},
    document: {
      body: { classList: { contains: () => false, toggle: () => {} } },
      querySelector: () => null,
    },
    resizeCodePane: () => {},
    window: { ditto: { browserHide: async () => {} } },
    showBrowser: async () => {},
    showCodeTerminal: async () => calls.push(["terminal", context.key]),
    renderCodeActivity: () => calls.push(["activity", context.key]),
  };
  return {
    context,
    calls,
    sync: vm.runInNewContext(`(${source.slice(sync.start, sync.end)})`, context),
  };
}

test("an open terminal follows the conversation and reattaches when returning", () => {
  const { context, calls, sync } = toolsHarness("terminal");
  sync();
  sync();
  context.key = "session:new-chat";
  sync();
  context.key = "session:first";
  sync();
  assert.deepEqual(calls, [
    ["terminal", "session:first"],
    ["terminal", "session:new-chat"],
    ["terminal", "session:first"],
  ]);
});

test("Activity refreshes for a new chat without replaying the previous conversation's tools", () => {
  const { context, calls, sync } = toolsHarness("activity");
  sync();
  sync();
  context.key = "session:new-chat";
  sync();
  assert.deepEqual(calls, [
    ["activity", "session:first"],
    ["activity", "session:new-chat"],
  ]);
});

test("missing-workspace history hides existing terminals and never opens a shell", async () => {
  const node = body.find(
    (node) => node.type === "FunctionDeclaration" && node.id.name === "showCodeTerminal",
  );
  const host = { hidden: false };
  const context = {
    codeWorkspaceUnavailable: true,
    terminals: new Map([["session:other", { host }]]),
    terminalLocation: {},
    window: {},
  };
  const showTerminal = vm.runInNewContext(`(${source.slice(node.start, node.end)})`, context);
  await showTerminal();
  assert.equal(host.hidden, true);
  assert.match(context.terminalLocation.textContent, /Choose a working folder/);
});

test("a terminal opened before its project disappears cannot regain focus or accept input", async () => {
  const node = body.find(
    (node) => node.type === "FunctionDeclaration" && node.id.name === "showCodeTerminal",
  );
  let opened;
  let input;
  let focused = false;
  let written = false;
  const context = {
    codeWorkspaceUnavailable: false,
    terminals: new Map(),
    terminalLocation: {},
    terminalHost: { append() {} },
    element: () => ({ hidden: false }),
    codeTerminalKey: () => "session:saved",
    codeTool: "terminal",
    fitCodeTerminal() {},
    window: {
      Terminal: class {
        loadAddon() {}
        open() {}
        onData(callback) {
          input = callback;
        }
        write() {}
        focus() {
          focused = true;
        }
      },
      FitAddon: {
        FitAddon: class {
          fit() {}
        },
      },
      ditto: {
        terminalOpen: () =>
          new Promise((resolve) => {
            opened = resolve;
          }),
        terminalWrite: async () => {
          written = true;
        },
      },
    },
  };
  const showTerminal = vm.runInNewContext(`(${source.slice(node.start, node.end)})`, context);
  const pending = showTerminal();
  context.codeWorkspaceUnavailable = true;
  await showTerminal();
  opened({ cwd: "/synthetic/project", output: "" });
  await pending;
  input("echo must-not-run\r");
  assert.equal(context.terminals.get("session:saved").host.hidden, true);
  assert.equal(focused, false);
  assert.equal(written, false);
});

test("opening unavailable history renders every saved turn and enters read-only mode", async () => {
  const node = body.find(
    (node) => node.type === "FunctionDeclaration" && node.id.name === "openCodeConversation",
  );
  const turns = Array.from({ length: 30 }, (_, i) => ({
    prompt: `Question ${i}`,
    response: `Answer ${i}`,
    workspace: "/synthetic/missing-project",
    provider: "pi",
    session_id: "saved-session",
    workspaceAvailable: false,
  }));
  const children = [];
  const context = {
    running: false,
    window: { ditto: { openCodeThread: async () => turns } },
    $: () => ({}),
    localChat: {
      querySelector: () => ({
        replaceChildren: () => {
          children.length = 0;
        },
        append: (...items) => children.push(...items),
      }),
      classList: { add() {} },
    },
    clearCodeResponses() {},
    element: (tag, _className, text) => ({ tag, text }),
    setCodeResponse: (target, text) => {
      target.text = text;
    },
    sharedOutput: {},
    openPanel() {},
    desktopMode() {},
    scrollLocalCode() {},
    renderCodeHistory() {},
    renderCodeActivity() {},
    codeTool: null,
    unavailableCodeWorkspaceMessage: "Choose a working folder",
    show: (_target, message) => {
      context.message = message;
    },
  };
  await vm.runInNewContext(
    `(${source.slice(node.start, node.end)})`,
    context,
  )({
    threadId: "session:saved-session",
  });
  assert.equal(context.codeWorkspaceUnavailable, true);
  assert.equal(context.workspaceReady, false);
  assert.equal(context.localSessionId, "saved-session");
  assert.equal(context.localWorkspace, "/synthetic/missing-project");
  assert.equal(context.message, "Choose a working folder");
  assert.equal(children.length, 61);
  assert.equal(children[0].text, "Question 0");
  assert.equal(children[1].text, "Answer 0");
  assert.equal(children[58].text, "Question 29");
  assert.equal(children[59].text, "Answer 29");
});

test("status refresh preserves the unavailable history's folder and cannot enable execution", async () => {
  const node = body.find(
    (node) => node.type === "FunctionDeclaration" && node.id.name === "refresh",
  );
  const controls = new Map();
  const control = (id) => {
    if (!controls.has(id)) controls.set(id, { replaceChildren() {}, append() {} });
    return controls.get(id);
  };
  const context = {
    codeWorkspaceUnavailable: true,
    workspaceReady: false,
    localWorkspace: "/synthetic/missing-project",
    running: false,
    window: {
      ditto: {
        status: async () => ({
          stats: {},
          pi: { ready: true, model: "fixture" },
          providers: [],
          workspace: "/synthetic/other-project",
          defaultWorkspace: "/synthetic/default",
          roots: [],
        }),
        recentRuns: async () => [],
        codeThreads: async () => [],
      },
    },
    $: control,
    number: String,
    show: (id, text) => {
      control(id).textContent = text;
    },
    document: { querySelectorAll: () => [] },
    roots() {},
    element() {},
    mountLocalCode() {},
    renderCodeHistory() {},
  };
  const refresh = vm.runInNewContext(`(${source.slice(node.start, node.end)})`, context);
  await refresh();
  assert.equal(context.workspaceReady, false);
  assert.equal(context.localWorkspace, "/synthetic/missing-project");
  assert.equal(control("#dl-workspace").textContent, "/synthetic/missing-project");
  assert.equal(control("#dl-default-workspace").hidden, false);
  assert.equal(control("#dl-progress").textContent, undefined);
});

test("starting a new chat leaves unavailable history and uses a fresh session without its folder", () => {
  const node = body.find(
    (node) => node.type === "FunctionDeclaration" && node.id.name === "newLocalTask",
  );
  let refreshed = false;
  const context = {
    codeWorkspaceUnavailable: true,
    localWorkspace: "/synthetic/missing-project",
    workspaceReady: false,
    activeCodeThread: { threadId: "session:old" },
    localSessionId: "old",
    localTurns: [{ prompt: "Saved question" }],
    crypto: { randomUUID: () => "fresh" },
    refresh: async () => {
      refreshed = true;
    },
    renderCodeHistory() {},
    syncCodeTools() {},
    clearCodeResponses() {},
    localChat: { querySelector: () => ({ replaceChildren() {} }), classList: { remove() {} } },
    sharedOutput: {},
    setCodeResponse() {},
    show() {},
    $: () => ({ selectedOptions: [{ textContent: "Ditto Code" }] }),
    desktopMode() {},
    scrollLocalCode() {},
  };
  vm.runInNewContext(`(${source.slice(node.start, node.end)})`, context)();
  assert.equal(context.codeWorkspaceUnavailable, false);
  assert.equal(context.activeCodeThread, null);
  assert.equal(context.localSessionId, "fresh");
  assert.equal(context.localTurns.length, 0);
  assert.equal(context.localWorkspace, "");
  assert.equal(context.workspaceReady, false);
  assert.equal(refreshed, true);
});
