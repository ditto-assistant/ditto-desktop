const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const source = fs.readFileSync(path.join(__dirname, "../src/desktop-shell.js"), "utf8");
const body = acorn.parse(source, { ecmaVersion: "latest" }).body[0].expression.callee.body.body;
const declaration = (name) => {
  const node = body.find((node) => node.type === "FunctionDeclaration" && node.id.name === name);
  return source.slice(node.start, node.end);
};

test("native browser yields to visible dialogs and drawers, and stays hidden outside its pane", () => {
  const context = {
    codePaneVisible: true,
    codeTool: "browser",
    document: { body: { classList: { contains: () => false } }, querySelectorAll: () => [] },
    getComputedStyle: (node) => ({ visibility: node.visibility || "visible" }),
  };
  const allowed = vm.runInNewContext(`(${declaration("codeBrowserAllowed")})`, context);
  assert.equal(allowed(), true);
  context.document.querySelectorAll = () => [{ getClientRects: () => [{}] }];
  assert.equal(allowed(), false, "a modal must never sit below the native view");
  context.document.querySelectorAll = () => [{ getClientRects: () => [] }];
  assert.equal(allowed(), true, "an unmounted or hidden modal does not block the pane");
  context.document.querySelectorAll = () => [];
  context.codeTool = "terminal";
  assert.equal(allowed(), false);
  context.codeTool = "browser";
  context.codePaneVisible = false;
  assert.equal(allowed(), false);
});

test("a late browser status response cannot reopen the view after a dialog opens or the pane closes", async () => {
  let complete;
  let visible = true;
  const shown = [];
  const context = {
    window: {
      ditto: {
        browserStatus: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
        browserShow: async (bounds) => shown.push(bounds),
      },
    },
    codeBrowserAllowed: () => visible,
    browserBounds: () => ({ x: 700, y: 100, width: 400, height: 600 }),
    browserState: () => {},
  };
  const show = vm.runInNewContext(`(${declaration("showBrowser")})`, context);
  const pending = show();
  visible = false;
  complete({ url: "https://example.com" });
  await pending;
  assert.equal(shown.length, 0);
  visible = true;
  const next = show();
  complete({ url: "https://example.com" });
  await next;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].width, 400);
});

test("Escape reaches terminal applications instead of closing their pane", () => {
  const listener = body.find(
    (node) =>
      node.type === "ExpressionStatement" &&
      node.expression.callee?.object?.name === "codePane" &&
      node.expression.callee?.property?.name === "addEventListener" &&
      node.expression.arguments[0]?.value === "keydown",
  ).expression.arguments[1];
  const terminalInput = {};
  let closed = 0;
  let intercepted = 0;
  const handler = vm.runInNewContext(`(${source.slice(listener.start, listener.end)})`, {
    terminalPanel: { contains: (target) => target === terminalInput },
    closePane: {
      click: () => {
        closed++;
      },
    },
  });
  handler({
    key: "Escape",
    target: terminalInput,
    stopPropagation: () => {
      intercepted++;
    },
  });
  assert.equal(closed, 0);
  assert.equal(intercepted, 0, "shell editors must receive Escape");
  handler({
    key: "Escape",
    target: {},
    stopPropagation: () => {
      intercepted++;
    },
  });
  assert.equal(closed, 1, "Escape still dismisses the pane from its own controls");
});
