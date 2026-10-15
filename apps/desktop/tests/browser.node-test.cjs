const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function browserFixture() {
  const events = [];
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
      on() {},
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
  return { browser: new context.module.exports.DesktopBrowser({}, () => {}), field, events };
}

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
