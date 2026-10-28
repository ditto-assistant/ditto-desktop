const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function browserFixture() {
  const events = [];
  const handlers = new Map();
  class Field {
    get value() {
      return this.currentValue || "";
    }
    set value(value) {
      this.currentValue = value;
    }
    focus() {}
    dispatchEvent(event) {
      events.push(event.type);
    }
  }
  const field = new Field();
  field.tagName = "INPUT";
  const dom = {
    document: {
      querySelector: (selector) => (selector === '[data-ditto-ref="d1"]' ? field : null),
    },
    HTMLInputElement: Field,
    HTMLTextAreaElement: Field,
    InputEvent: function fixtureInputEvent(type) {
      this.type = type;
    },
    Event: function fixtureEvent(type) {
      this.type = type;
    },
  };
  class View {
    webContents = {
      setWindowOpenHandler() {},
      on: (name, handler) => handlers.set(name, handler),
      close() {},
      getURL: () => "http://127.0.0.1/qa",
      getTitle: () => "QA",
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScript: async (script) => vm.runInNewContext(script, dom),
    };
  }
  const context = {
    module: { exports: {} },
    require: (name) => {
      assert.equal(name, "electron");
      return { WebContentsView: View };
    },
    URL,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/browser.cjs"), "utf8"), context);
  return {
    browser: new context.module.exports.DesktopBrowser({}, () => {}),
    field,
    events,
    emit: (name, ...args) => handlers.get(name)?.(...args),
  };
}

test("main-page failures survive status updates until a new page navigation starts", () => {
  const { browser, emit } = browserFixture();
  browser.ensure();
  emit("did-fail-load", {}, -324, "ERR_EMPTY_RESPONSE", "http://127.0.0.1/qa", true);
  assert.match(browser.status().error, /could not load/);
  const failure = browser.status().error;
  emit("page-title-updated");
  emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  assert.equal(browser.status().error, failure);
  emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  assert.equal(browser.status().error, failure);
  emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.equal(browser.status().error, "");
});

test("subframe failures and cancelled navigations do not report a failed page", () => {
  const { browser, emit } = browserFixture();
  browser.ensure();
  emit("did-fail-load", {}, -324, "ERR_EMPTY_RESPONSE", "http://127.0.0.1/frame", false);
  assert.ok(!browser.status().error);
  emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://127.0.0.1/old", true);
  assert.ok(!browser.status().error);
});

test("closing a failed browser clears its error before a fresh view is created", () => {
  const { browser, emit } = browserFixture();
  browser.ensure();
  emit("did-fail-load", {}, -324, "ERR_EMPTY_RESPONSE", "http://127.0.0.1/qa", true);
  assert.ok(browser.status().error);
  browser.close();
  browser.ensure();
  assert.equal(browser.status().error, "");
});

test("browser fill changes the inspected field and returns a completion receipt", async () => {
  const { browser, field, events } = browserFixture();
  const receipt = await browser.fill("d1", "Ditto café ✓");
  assert.equal(field.value, "Ditto café ✓");
  assert.deepEqual(events, ["input", "change"]);
  assert.equal(receipt.filled, true);
  assert.equal(receipt.ref, "d1");
  assert.equal(receipt.url, "http://127.0.0.1/qa");
});

test("browser fill rejects stale and invalid targets without modifying a field", async () => {
  const { browser, field, events } = browserFixture();
  await assert.rejects(browser.fill("d2", "wrong target"), /no longer available/);
  await assert.rejects(browser.fill('d1"]', "invalid reference"), /listed field/);
  assert.equal(field.value, "");
  assert.deepEqual(events, []);
});
