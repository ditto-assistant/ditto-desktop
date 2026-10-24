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
