const test = require("node:test");
const assert = require("node:assert/strict");
const {
  registerLiveBridge,
  toScreenPoint,
  toDesktopPixels,
  parseFrontApp,
} = require("../src/live/live-bridge.cjs");

// Retina primary at the origin, a 1x display to its left.
const PRIMARY = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 };
const LEFT = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };

function fakeWindow({ id, bounds = { x: 0, y: 0, width: 100, height: 100 }, protectedContent }) {
  const sent = [];
  const scripts = [];
  return {
    id,
    sent,
    scripts,
    opacity: 1,
    ignore: null,
    shown: false,
    hidden: false,
    scriptResult: undefined,
    webContents: {
      send: (channel, value) => sent.push([channel, value]),
      executeJavaScript(source) {
        scripts.push(source);
        return Promise.resolve(this.owner.scriptResult);
      },
    },
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getBounds: () => bounds,
    getTitle: () => "Ditto",
    isContentProtected: () => protectedContent,
    getOpacity() {
      return this.opacity;
    },
    setOpacity(value) {
      this.opacity = value;
    },
    setIgnoreMouseEvents(ignore) {
      this.ignore = ignore;
    },
    show() {
      this.shown = true;
    },
    focus() {},
    hide() {
      this.hidden = true;
    },
  };
}

function fixture({ cursor = { x: 10, y: 10 }, windows = [], enabled = true } = {}) {
  const main = fakeWindow({ id: 1 });
  main.webContents.owner = main;
  const aura = fakeWindow({
    id: 2,
    bounds: { x: 1400, y: 880, width: 100, height: 100 },
    protectedContent: true,
  });
  aura.webContents.owner = aura;
  const calls = [];
  const closed = [];
  const commands = [];
  const handlers = new Map();
  const listeners = new Map();
  let focused = null;
  const state = { cursor, failNext: null, errorNext: null, frontPid: 77 };
  // Mirrors ComputerService's barrier: an unverifiable action blocks input
  // until a desktop screenshot is observed.
  let unverified = false;
  const session = {
    call: async (name, args) => {
      calls.push([name, args]);
      if (state.failNext) {
        const error = state.failNext;
        state.failNext = null;
        throw error;
      }
      if (state.errorNext) {
        const text = state.errorNext;
        state.errorNext = null;
        return { isError: true, content: [{ type: "text", text }] };
      }
      if (name === "computer_get_desktop_state") {
        unverified = false;
        return { content: [{ type: "image", data: "png" }, { type: "text", text: "desktop" }] };
      }
      if (name === "computer_list_windows") return { structuredContent: { windows } };
      if (unverified) return { isError: true, content: [{ type: "text", text: "barrier" }] };
      unverified = true;
      return {
        content: [{ type: "text", text: `${name} done` }],
        structuredContent: { effect: "unverifiable" },
      };
    },
  };
  const computer = {
    enabled,
    onChangeCalls: [],
    onChange(status) {
      this.onChangeCalls.push(status);
    },
    createSession: async () => {
      if (!computer.enabled) throw new Error("Enable Computer Use in Ditto Desktop first.");
      const id = closed.length + calls.length;
      return { ...session, id, close: () => closed.push(id) };
    },
  };
  const original = computer.onChange;
  const capturer = { requests: [] };
  const electron = {
    BrowserWindow: { getFocusedWindow: () => focused },
    app: { getName: () => "Ditto Desktop", focus() {} },
    screen: {
      getCursorScreenPoint: () => state.cursor,
      getAllDisplays: () => [PRIMARY, LEFT],
      getPrimaryDisplay: () => PRIMARY,
      getDisplayNearestPoint: (point) => (point.x < 0 ? LEFT : PRIMARY),
      getDisplayMatching: (bounds) => (bounds.x < 0 ? LEFT : PRIMARY),
    },
    desktopCapturer: {
      async getSources(options) {
        capturer.requests.push({ options, auraOpacity: aura.opacity });
        return [PRIMARY, LEFT].map((display) => ({
          display_id: String(display.id),
          thumbnail: {
            isEmpty: () => false,
            getSize: () => options.thumbnailSize,
            toJPEG: (quality) => Buffer.from(`jpeg:${display.id}:${quality}`),
          },
        }));
      },
    },
  };
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel) => listeners.delete(channel),
  };
  const runs = [];
  const bridge = registerLiveBridge({
    ipcMain,
    computer,
    getMainWindow: () => main,
    getAuraWindow: () => aura,
    getSession: async () => ({ token: "t", sessionId: "s" }),
    emit: (channel, value) => commands.push([channel, value]),
    electron,
    platform: "darwin",
    pid: 4242,
    run: async (file, args) => {
      runs.push(args);
      if (args[0] === "front") return "ASN:0x0-0xf05f05:\n";
      return `"LSDisplayName"="Safari"\n"CFBundleIdentifier"="com.apple.Safari"\n"pid"=${state.frontPid}\n`;
    },
  });
  const event = { sender: aura.webContents };
  const invoke = (key, ...args) => handlers.get(`ditto-live:${key}`)(event, ...args);
  return {
    bridge,
    main,
    aura,
    calls,
    closed,
    commands,
    handlers,
    listeners,
    computer,
    original,
    capturer,
    state,
    runs,
    invoke,
    setFocused: (window) => {
      focused = window;
    },
    tool: (name, args) => invoke("tool", name, args),
  };
}

test("normalized coordinates map to global points on multi-display, retina setups", () => {
  assert.deepEqual(toScreenPoint(PRIMARY, 500, 500), { x: 756, y: 491 });
  assert.deepEqual(toScreenPoint(LEFT, 0, 0), { x: -1920, y: 0 });
  assert.deepEqual(toScreenPoint(LEFT, 1000, 1000), { x: -1, y: 1079 });
  // cmux desktop clicks take main-display screenshot pixels.
  assert.deepEqual(toDesktopPixels(PRIMARY, { x: -960, y: 540 }), { x: -1920, y: 1080 });
  assert.throws(() => toScreenPoint(PRIMARY, 1001, 0), /0 to 1000/);
  assert.throws(() => toScreenPoint(PRIMARY, Number.NaN, 0), /0 to 1000/);
});

test("clicks map onto the display of the latest frame and observe before acting", async () => {
  const live = fixture({ cursor: { x: -100, y: 100 } });
  live.bridge.startSession();
  const frame = await live.invoke("capture", { maxWidth: 960 });
  assert.deepEqual(frame.display, { ...LEFT.bounds, scaleFactor: 1 });
  assert.equal(frame.width, 960);
  assert.equal(frame.height, 540);
  assert.equal(Buffer.from(frame.data, "base64").toString(), "jpeg:2:60");

  // The cursor moving later does not change which display the model saw.
  live.state.cursor = { x: 10, y: 10 };
  assert.deepEqual(await live.tool("computer_click", { x: 500, y: 500 }), {
    ok: true,
    result: "computer_click done",
  });
  assert.deepEqual(await live.tool("computer_click", { x: 0, y: 0, double: true }), {
    ok: true,
    result: "computer_click done",
  });
  assert.deepEqual(live.calls, [
    ["computer_get_desktop_state", {}],
    ["computer_click", { x: -1920, y: 1080, scope: "desktop", button: "left" }],
    ["computer_get_desktop_state", {}],
    ["computer_click", { x: -3840, y: 0, scope: "desktop", button: "left", count: 2 }],
  ]);
});

test("clicks on the aura are refused before reaching Computer Use", async () => {
  const live = fixture();
  live.bridge.startSession();
  await live.invoke("capture");
  // 960/1000 * 1512 = 1452, 950/1000 * 982 = 933: inside the aura.
  const result = await live.tool("computer_click", { x: 960, y: 950 });
  assert.equal(result.ok, false);
  assert.match(result.error, /aura/);
  const drag = await live.tool("computer_drag", { from_x: 10, from_y: 10, to_x: 960, to_y: 950 });
  assert.equal(drag.ok, false);
  assert.deepEqual(live.calls, []);
});

test("scroll and drag target the topmost window under the point in its own pixels", async () => {
  const windows = [
    { pid: 10, window_id: 1, layer: 0, z_index: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
    { pid: 11, window_id: 2, layer: 0, z_index: 5, bounds: { x: 100, y: 100, width: 800, height: 600 } },
    { pid: 12, window_id: 3, layer: 25, z_index: 9, bounds: { x: 0, y: 0, width: 1512, height: 30 } },
  ];
  const live = fixture({ windows });
  live.bridge.startSession();
  await live.invoke("capture");
  assert.equal((await live.tool("computer_scroll", { x: 500, y: 500, direction: "down" })).ok, true);
  assert.deepEqual(live.calls.at(-1), [
    "computer_scroll",
    { pid: 11, window_id: 2, direction: "down", amount: 3, x: (756 - 100) * 2, y: (491 - 100) * 2 },
  ]);
  const result = await live.tool("computer_drag", { from_x: 0, from_y: 0, to_x: 100, to_y: 100 });
  assert.equal(result.ok, true);
  assert.deepEqual(live.calls.at(-1), [
    "computer_drag",
    { pid: 10, window_id: 1, from_x: 0, from_y: 0, to_x: 302, to_y: 196 },
  ]);
});

test("keyboard input goes to the frontmost app and validates its arguments", async () => {
  const live = fixture();
  live.bridge.startSession();
  await live.tool("computer_type_text", { text: "hello" });
  await live.tool("computer_press_key", { key: "Return", modifiers: ["command", "shift"] });
  assert.deepEqual(
    live.calls.filter(([name]) => name !== "computer_get_desktop_state"),
    [
      ["computer_type_text", { pid: 77, text: "hello" }],
      ["computer_press_key", { pid: 77, key: "return", modifiers: ["cmd", "shift"] }],
    ],
  );
  const bad = await live.tool("computer_press_key", { key: "a", modifiers: ["hyper"] });
  assert.deepEqual(bad, { ok: false, error: "Use modifiers cmd, shift, option, ctrl or fn." });
  assert.equal((await live.tool("computer_type_text", { text: "" })).ok, false);
  assert.equal((await live.tool("nope", {})).ok, false);
});

test("one computer session per live session, closed on stop and on Computer Use disable", async () => {
  const live = fixture();
  const stops = [];
  live.bridge.onStop((reason) => stops.push(reason));
  assert.deepEqual(await live.tool("computer_click", { x: 1, y: 1 }), {
    ok: false,
    error: "Live mode is not running.",
  });

  live.bridge.startSession();
  assert.deepEqual(live.commands.at(-1), ["ditto-live:command", { type: "start" }]);
  await live.tool("computer_click", { x: 1, y: 1 });
  await live.tool("computer_click", { x: 2, y: 2 });
  live.invoke("stop", "aura button");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(live.closed.length, 1);
  assert.deepEqual(stops, ["aura button"]);
  assert.deepEqual(live.commands.at(-1), ["ditto-live:command", { type: "stop" }]);
  assert.equal(live.bridge.active, false);

  // A new live session opens a fresh computer session and re-observes.
  live.bridge.startSession();
  live.calls.length = 0;
  await live.tool("computer_click", { x: 1, y: 1 });
  assert.equal(live.calls[0][0], "computer_get_desktop_state");

  live.computer.enabled = false;
  live.computer.onChange({ enabled: false });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(live.computer.onChangeCalls, [{ enabled: false }]);
  assert.deepEqual(stops, ["aura button", "computer-use-disabled"]);
  assert.equal(live.closed.length, 2);
});

test("errors come back as results and never throw across IPC", async () => {
  const live = fixture({ enabled: false });
  live.bridge.startSession();
  assert.deepEqual(await live.tool("computer_click", { x: 1, y: 1 }), {
    ok: false,
    error: "Turn on Computer Use in Ditto Desktop first.",
  });
  live.computer.enabled = true;
  live.state.errorNext = "No main display detected.";
  assert.deepEqual(await live.tool("computer_click", { x: 1, y: 1 }), {
    ok: false,
    error: "No main display detected.",
  });
  // A failed observation keeps the barrier: the next action observes again.
  await live.tool("computer_click", { x: 1, y: 1 });
  assert.deepEqual(
    live.calls.map(([name]) => name),
    ["computer_get_desktop_state", "computer_get_desktop_state", "computer_click"],
  );

  // A session that ended underneath us is dropped and reopened on the next call.
  live.state.failNext = new Error("This computer-use session has ended.");
  const ended = await live.tool("computer_click", { x: 1, y: 1 });
  assert.deepEqual(ended, { ok: false, error: "This computer-use session has ended." });
  await Promise.resolve();
  assert.equal(live.closed.length, 1);
  assert.equal(live.bridge.active, true);
  live.calls.length = 0;
  await live.tool("computer_click", { x: 1, y: 1 });
  assert.equal(live.calls[0][0], "computer_get_desktop_state");
});

test("only the aura renderer can use the live channels", async () => {
  const live = fixture();
  const handler = live.handlers.get("ditto-live:tool");
  assert.throws(
    () => handler({ sender: live.main.webContents }, "computer_get_state", {}),
    /only available in the Ditto aura/,
  );
  assert.deepEqual(await live.invoke("session"), { token: "t", sessionId: "s" });
  live.listeners.get("ditto-live:interactive")({ sender: live.aura.webContents }, true);
  assert.equal(live.aura.ignore, false);
  live.listeners.get("ditto-live:interactive")({ sender: live.main.webContents }, false);
  assert.equal(live.aura.ignore, false);
});

test("frontmost reports Ditto focus, otherwise the macOS frontmost app", async () => {
  assert.deepEqual(parseFrontApp('"LSDisplayName"="Notes"\n"pid"=9\n'), {
    app: "Notes",
    bundleId: undefined,
    pid: 9,
  });
  const live = fixture();
  live.setFocused(live.main);
  assert.deepEqual(await live.invoke("frontmost"), {
    app: "Ditto Desktop",
    title: "Ditto",
    isDitto: true,
  });
  live.setFocused(live.aura);
  assert.deepEqual(await live.invoke("frontmost"), {
    app: "Safari",
    bundleId: "com.apple.Safari",
    isDitto: false,
  });
  // Polling within the cache window does not spawn lsappinfo again.
  await live.invoke("frontmost");
  assert.equal(live.runs.length, 2);
});

test("frontmost counts Ditto's own process as Ditto", async () => {
  const live = fixture();
  live.state.frontPid = 4242;
  assert.equal((await live.invoke("frontmost")).isDitto, true);
});

test("capture hides an unprotected aura for the frame and restores it", async () => {
  const live = fixture();
  live.aura.isContentProtected = () => false;
  live.aura.opacity = 0.9;
  await live.invoke("capture", { maxWidth: 4000, quality: 0.5 });
  assert.equal(live.capturer.requests[0].auraOpacity, 0);
  assert.deepEqual(live.capturer.requests[0].options.thumbnailSize, { width: 3024, height: 1964 });
  assert.equal(live.aura.opacity, 0.9);
});

test("computer_get_state reports frontmost and the latest frame's screen", async () => {
  const live = fixture({ cursor: { x: -5, y: 5 } });
  live.bridge.startSession();
  await live.invoke("capture");
  const state = await live.tool("computer_get_state", {});
  assert.deepEqual(state.result.screen, { ...LEFT.bounds, scaleFactor: 1 });
  assert.equal(state.result.frontmost.app, "Safari");
  assert.equal(state.result.displays, 2);
});

test("ditto_app drives the main window", async () => {
  const live = fixture();
  live.bridge.startSession();
  assert.deepEqual(await live.tool("ditto_app", { action: "show" }), {
    ok: true,
    result: "Ditto is in front.",
  });
  assert.equal(live.main.shown, true);
  await live.tool("ditto_app", { action: "hide" });
  assert.equal(live.main.hidden, true);

  live.main.scriptResult = "/code";
  assert.deepEqual(await live.tool("ditto_app", { action: "navigate", target: "code" }), {
    ok: true,
    result: "Ditto is showing /code.",
  });
  assert.match(live.main.scripts.at(-1), /"path":"\/code"/);
  const injected = await live.tool("ditto_app", { action: "navigate", target: "javascript:alert(1)" });
  assert.equal(injected.ok, false);

  live.main.scriptResult = false;
  assert.equal((await live.tool("ditto_app", { action: "new_chat" })).ok, false);

  live.main.scriptResult = { status: "started", jobId: "x" };
  const asked = await live.tool("ditto_app", { action: "ask_code", prompt: 'fix "quotes"' });
  assert.equal(asked.ok, true);
  assert.match(live.main.scripts.at(-1), /"fix \\"quotes\\""/);
  live.main.scriptResult = { status: "blocked", reason: "A local task is still running." };
  assert.deepEqual(await live.tool("ditto_app", { action: "ask_code", prompt: "again" }), {
    ok: false,
    error: "A local task is still running.",
  });
});

test("dispose removes every channel and restores the Computer Use hook", () => {
  const live = fixture();
  live.bridge.startSession();
  live.bridge.dispose();
  assert.equal(live.handlers.size, 0);
  assert.equal(live.listeners.size, 0);
  assert.equal(live.computer.onChange, live.original);
  assert.throws(() => live.bridge.startSession(), /shut down/);
});
