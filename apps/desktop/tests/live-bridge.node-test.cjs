const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  registerLiveBridge,
  toScreenPoint,
  toDesktopPixels,
  desktopRatio,
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
    url: "app://ditto/",
    // When set, scripts run against it as `window`, like the renderer would.
    page: null,
    navListeners: new Map(),
    webContents: {
      mainFrame: { name: "main" },
      send: (channel, value) => sent.push([channel, value]),
      executeJavaScript(source) {
        scripts.push(source);
        const { page } = this.owner;
        if (page) return Promise.resolve(new Function("window", `return ${source}`)(page));
        return Promise.resolve(this.owner.scriptResult);
      },
      getURL() {
        return this.owner.url;
      },
      on(name, listener) {
        this.owner.navListeners.set(name, listener);
      },
      removeListener(name) {
        this.owner.navListeners.delete(name);
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

function fixture({
  cursor = { x: 10, y: 10 },
  windows = [],
  enabled = true,
  run: runOverride,
  recordDiagnostic: recordOverride,
} = {}) {
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
  const diagnostics = [];
  const handlers = new Map();
  const listeners = new Map();
  let focused = null;
  const state = {
    cursor,
    failNext: null,
    errorNext: null,
    frontPid: 77,
    desktop: { screenshot_width: 3024, screen_width: 1512 },
    launchedPid: 88,
    activate: true,
    verified: undefined,
  };
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
        return {
          content: [
            { type: "image", data: "png" },
            { type: "text", text: "desktop" },
          ],
          structuredContent: state.desktop,
        };
      }
      if (name === "computer_list_windows") return { structuredContent: { windows } };
      if (unverified) return { isError: true, content: [{ type: "text", text: "barrier" }] };
      if (name === "computer_launch_app")
        return {
          content: [{ type: "text", text: "Launched app in background." }],
          structuredContent: { pid: state.launchedPid },
        };
      if (name === "computer_bring_to_front" && state.activate) state.frontPid = args.pid;
      unverified = true;
      return {
        content: [{ type: "text", text: `${name} done` }],
        structuredContent: { effect: "unverifiable", verified: state.verified },
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
            toJPEG: (quality) =>
              state.jpeg ? state.jpeg(quality) : Buffer.from(`jpeg:${display.id}:${quality}`),
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
    recordDiagnostic: recordOverride ?? ((event) => diagnostics.push(event)),
    electron,
    platform: "darwin",
    pid: 4242,
    run: async (file, args) => {
      runs.push(args);
      if (runOverride) return runOverride(file, args);
      if (args[0] === "front") return "ASN:0x0-0xf05f05:\n";
      return `"LSDisplayName"="Safari"\n"CFBundleIdentifier"="com.apple.Safari"\n"pid"=${state.frontPid}\n`;
    },
  });
  const event = { sender: aura.webContents, senderFrame: aura.webContents.mainFrame };
  const fromMain = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  const invoke = (key, ...args) => handlers.get(`ditto-live:${key}`)(event, ...args);
  return {
    bridge,
    main,
    aura,
    calls,
    closed,
    commands,
    diagnostics,
    handlers,
    listeners,
    computer,
    original,
    capturer,
    electron,
    state,
    runs,
    invoke,
    setFocused: (window) => {
      focused = window;
    },
    tool: (name, args) => invoke("tool", name, args),
    fromMain,
  };
}

test("normalized coordinates map to global points on multi-display, retina setups", () => {
  assert.deepEqual(toScreenPoint(PRIMARY, 500, 500), { x: 756, y: 491 });
  assert.deepEqual(toScreenPoint(LEFT, 0, 0), { x: -1920, y: 0 });
  assert.deepEqual(toScreenPoint(LEFT, 1000, 1000), { x: -1, y: 1079 });
  // cmux desktop clicks take main-display screenshot pixels.
  assert.deepEqual(toDesktopPixels(2, { x: -960, y: 540 }), { x: -1920, y: 1080 });
  // The sidecar divides by its screenshot/screen width ratio, which can differ
  // from the backing scale (observed: 3592px shots of a 1728pt Retina screen).
  assert.equal(desktopRatio({ screenshot_width: 3592, screen_width: 1728 }, 2), 3592 / 1728);
  assert.equal(desktopRatio({ screenshot_width: 1512, screen_width: 1512 }, 2), 1);
  assert.equal(desktopRatio(undefined, 2), 2);
  assert.throws(() => toScreenPoint(PRIMARY, 1001, 0), /0 to 1000/);
  assert.throws(() => toScreenPoint(PRIMARY, Number.NaN, 0), /0 to 1000/);
});

for (const restart of [false, true])
  test(`Stop rejects an already queued Ditto action (restart=${restart})`, async (t) => {
    const live = fixture();
    t.after(() => live.bridge.dispose());
    live.bridge.startSession();
    const queued = live.tool("ditto_app", { action: "hide" });
    live.bridge.stopSession("user");
    if (restart) live.bridge.startSession();
    assert.equal((await queued).ok, false);
    assert.equal(live.main.hidden, false);
    if (restart) {
      assert.equal((await live.tool("ditto_app", { action: "hide" })).ok, true);
      assert.equal(live.main.hidden, true);
    }
  });

test("a queued computer action cannot acquire a restarted Live session", async (t) => {
  const live = fixture();
  t.after(() => live.bridge.dispose());
  live.bridge.startSession();
  const queued = live.tool("computer_click", { x: 1, y: 1 });
  live.bridge.stopSession("user");
  live.bridge.startSession();
  assert.equal((await queued).ok, false);
  assert.equal(live.calls.length, 0);
  assert.equal((await live.tool("computer_click", { x: 1, y: 1 })).ok, true);
});

test("an in-flight app lookup cannot type into a later Live session", async (t) => {
  const looking = Promise.withResolvers();
  const release = Promise.withResolvers();
  let lookups = 0;
  const live = fixture({
    run: async (_file, args) => {
      if (args[0] === "front") {
        lookups += 1;
        looking.resolve();
        await release.promise;
        return "ASN:0x0-0xf05f05:\n";
      }
      return `"LSDisplayName"="Fixture"\n"pid"=${lookups === 1 ? 77 : 99}\n`;
    },
  });
  t.after(() => live.bridge.dispose());
  live.bridge.startSession();
  const typing = live.tool("computer_type_text", { text: "Synthetic stopped input" });
  await looking.promise;
  live.bridge.stopSession("user");
  live.bridge.startSession();
  release.resolve();
  assert.equal((await typing).ok, false);
  assert.deepEqual(
    live.calls.map(([name]) => name),
    ["computer_get_desktop_state"],
  );
  assert.equal(
    (await live.tool("computer_type_text", { text: "Synthetic current input" })).ok,
    true,
  );
  assert.equal(live.calls.at(-1)[1].pid, 99);
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
  assert.deepEqual(live.calls, [
    ["computer_get_desktop_state", {}],
    ["computer_click", { x: -1920, y: 1080, scope: "desktop", button: "left" }],
  ]);
});

test("clicks use the ratio from the observation taken right before them", async () => {
  const live = fixture();
  live.state.desktop = { screenshot_width: 3592, screen_width: 1728 };
  live.bridge.startSession();
  await live.invoke("capture");
  await live.tool("computer_click", { x: 500, y: 500, button: "right" });
  const ratio = 3592 / 1728;
  assert.deepEqual(live.calls.at(-1), [
    "computer_click",
    { x: 756 * ratio, y: 491 * ratio, scope: "desktop", button: "right" },
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
    {
      pid: 10,
      window_id: 1,
      layer: 0,
      z_index: 1,
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
    },
    {
      pid: 11,
      window_id: 2,
      layer: 0,
      z_index: 5,
      bounds: { x: 100, y: 100, width: 800, height: 600 },
    },
    {
      pid: 12,
      window_id: 3,
      layer: 25,
      z_index: 9,
      bounds: { x: 0, y: 0, width: 1512, height: 30 },
    },
  ];
  const live = fixture({ windows });
  live.bridge.startSession();
  await live.invoke("capture");
  assert.equal(
    (await live.tool("computer_scroll", { x: 500, y: 500, direction: "down" })).ok,
    true,
  );
  assert.deepEqual(live.calls.at(-1), [
    "computer_scroll",
    {
      pid: 11,
      window_id: 2,
      direction: "down",
      amount: 3,
      x: (756 - 100) * 2,
      y: (491 - 100) * 2,
      delivery_mode: "foreground",
    },
  ]);
  // The engine's screen-absolute click has no click count; double_click
  // needs the window under the point.
  assert.equal((await live.tool("computer_click", { x: 500, y: 500, double: true })).ok, true);
  assert.deepEqual(live.calls.at(-1), [
    "computer_double_click",
    { pid: 11, window_id: 2, x: (756 - 100) * 2, y: (491 - 100) * 2 },
  ]);
  const result = await live.tool("computer_drag", { from_x: 0, from_y: 0, to_x: 100, to_y: 100 });
  assert.equal(result.ok, true);
  assert.deepEqual(live.calls.at(-1), [
    "computer_drag",
    {
      pid: 10,
      window_id: 1,
      from_x: 0,
      from_y: 0,
      to_x: 302,
      to_y: 196,
      delivery_mode: "foreground",
    },
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

test("Live tool diagnostics keep fixed metadata and only native boolean verification", async () => {
  const live = fixture();
  live.bridge.startSession();
  live.state.verified = false;
  await live.tool("computer_type_text", { text: "private-payload-never-record" });
  assert.deepEqual(live.diagnostics, [
    { event: "native_tool", tool: "computer_get_desktop_state", outcome: "ok" },
    { event: "native_tool", tool: "computer_type_text", outcome: "ok", verified: false },
    { event: "tool", tool: "computer_type_text", outcome: "ok" },
  ]);
  live.diagnostics.length = 0;
  live.state.errorNext = "private-native-error-never-record";
  await live.tool("computer_type_text", { text: "private-payload-never-record" });
  assert.deepEqual(live.diagnostics, [
    { event: "native_tool", tool: "computer_get_desktop_state", outcome: "error" },
    { event: "tool", tool: "computer_type_text", outcome: "error" },
  ]);
  live.diagnostics.length = 0;
  await live.tool("private-unknown-tool-never-record", {});
  assert.deepEqual(live.diagnostics, []);
});

test("diagnostics do not infer verification or interfere with native actions", async () => {
  const live = fixture();
  live.bridge.startSession();
  live.state.verified = "private-nonboolean-never-record";
  await live.tool("computer_press_key", { key: "return" });
  assert.equal(
    live.diagnostics.some((event) => "verified" in event),
    false,
  );
  const brokenSink = fixture({
    recordDiagnostic: () => {
      throw new Error("sink unavailable");
    },
  });
  brokenSink.bridge.startSession();
  assert.equal((await brokenSink.tool("computer_press_key", { key: "return" })).ok, true);
});

test("opening an app activates the launched process before the next keyboard action", async () => {
  const live = fixture();
  live.bridge.startSession();
  await live.invoke("capture");
  await live.invoke("frontmost");
  const opened = await live.tool("computer_open_app", { name: "Google Chrome" });
  assert.equal(opened.ok, true);
  assert.deepEqual(
    live.calls.filter(([name]) => name !== "computer_get_desktop_state"),
    [
      ["computer_launch_app", { name: "Google Chrome", display: "id:1" }],
      ["computer_bring_to_front", { pid: 88 }],
    ],
  );
  await live.tool("computer_press_key", { key: "l", modifiers: ["cmd"] });
  assert.equal(live.calls.at(-1)[1].pid, 88);
});

test("opening an app without a valid launched PID cannot report foreground success", async () => {
  const live = fixture();
  live.state.launchedPid = undefined;
  live.bridge.startSession();
  const opened = await live.tool("computer_open_app", { name: "Google Chrome" });
  assert.equal(opened.ok, false);
  assert.match(opened.error, /process/);
  assert.equal(
    live.calls.some(([name]) => name === "computer_bring_to_front"),
    false,
  );
});

test("an activation that leaves another app in front fails and prevents dependent typing", async () => {
  const live = fixture();
  live.state.activate = false;
  live.bridge.startSession();
  const opened = await live.tool("computer_open_app", { name: "Google Chrome" });
  assert.equal(opened.ok, false);
  assert.match(opened.error, /front/);
  const typed = await live.tool("computer_type_text", { text: "YouTube.com" });
  assert.equal(typed.ok, false);
  assert.equal(
    live.calls.some(([name]) => name === "computer_type_text"),
    false,
  );
});

test("keyboard input cannot use a cached app or type after the opened app loses focus", async () => {
  const live = fixture();
  live.bridge.startSession();
  await live.invoke("frontmost");
  live.state.frontPid = 89;
  await live.tool("computer_type_text", { text: "hello" });
  assert.equal(live.calls.at(-1)[1].pid, 89);
  assert.equal((await live.tool("computer_open_app", { name: "Google Chrome" })).ok, true);
  live.state.frontPid = 99;
  const key = await live.tool("computer_press_key", { key: "l", modifiers: ["cmd"] });
  assert.equal(key.ok, false);
  assert.match(key.error, /front/);
  assert.equal(
    live.calls.some(([name]) => name === "computer_press_key"),
    false,
  );
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
  assert.deepEqual(live.aura.sent.at(-1), ["ditto-live:command", { type: "start" }]);
  live.invoke("state", "listening");
  live.invoke("state", "bogus");
  await live.tool("computer_click", { x: 1, y: 1 });
  await live.tool("computer_click", { x: 2, y: 2 });
  live.invoke("stop", "aura button");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(live.closed.length, 1);
  assert.deepEqual(stops, ["aura button"]);
  assert.deepEqual(live.aura.sent.at(-1), ["ditto-live:command", { type: "stop" }]);
  // The main window hears state changes through main.cjs's emit.
  assert.deepEqual(live.commands, [
    ["ditto:live-state", "connecting"],
    ["ditto:live-state", "listening"],
    ["ditto:live-state", "idle"],
  ]);
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
  const subframe = { sender: live.aura.webContents, senderFrame: { name: "child" } };
  assert.throws(
    () => live.handlers.get("ditto-live:session")(subframe),
    /only available in the Ditto aura/,
  );
  // The token, the screen and the frontmost app are only handed out while Live runs.
  assert.throws(() => live.invoke("session"), /not running/);
  assert.throws(() => live.invoke("capture", {}), /not running/);
  assert.throws(() => live.invoke("frontmost"), /not running/);
  live.bridge.startSession();
  assert.deepEqual(await live.invoke("session"), { token: "t", sessionId: "s" });
  live.listeners.get("ditto-live:interactive")(
    { sender: live.aura.webContents, senderFrame: live.aura.webContents.mainFrame },
    true,
  );
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
  live.bridge.startSession();
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
  live.bridge.startSession();
  live.state.frontPid = 4242;
  assert.equal((await live.invoke("frontmost")).isDitto, true);
});

test("capture hides an unprotected aura for the frame and restores it", async () => {
  const live = fixture();
  live.bridge.startSession();
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
  const injected = await live.tool("ditto_app", {
    action: "navigate",
    target: "javascript:alert(1)",
  });
  assert.equal(injected.ok, false);

  assert.equal(
    (await live.tool("ditto_app", { action: "navigate", target: "//evil.example" })).ok,
    false,
  );

  live.main.scriptResult = false;
  assert.equal((await live.tool("ditto_app", { action: "new_chat" })).ok, false);
  // The declaration offers a first message; the result must not claim it was sent.
  live.main.scriptResult = true;
  const opened = await live.tool("ditto_app", { action: "new_chat", prompt: "Plan my week" });
  assert.match(opened.result, /not sent/);

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

test("an onStop listener may dispose the bridge without re-entering stop", async () => {
  const live = fixture();
  const stops = [];
  live.bridge.onStop((reason) => {
    stops.push(reason);
    live.bridge.dispose();
  });
  live.bridge.startSession();
  await live.tool("computer_click", { x: 1, y: 1 });
  live.bridge.dispose();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(stops, ["disposed"]);
  assert.equal(live.closed.length, 1);
  assert.equal(live.handlers.size, 0);
});

// A Ditto window whose shim wraps ditto-app's createLiveClientActions.
function fakeShim(handle) {
  const ready = [];
  const context = {
    type: "client_context",
    route: "/agents/a1",
    surface: "agent",
    activeAgentId: "a1",
    activeThreadId: "t1",
    destinations: [{ key: "settings.memory", label: "Memory settings" }],
  };
  return {
    ready,
    context,
    page: {
      __dittoDesktopLive: {
        setReady: async (value) => (ready.push(value), true),
        context: () => context,
        handle,
      },
    },
  };
}

test("client action frames reach ditto-app's live actions in the Ditto window", async () => {
  const live = fixture();
  live.bridge.startSession();
  const frames = [];
  const shim = fakeShim(async (frame) => {
    frames.push(frame);
    return {
      result: { type: "client_action_result", id: frame.id, ok: true, summary: "Went back." },
      context: shim.context,
    };
  });
  live.main.page = shim.page;
  const frame = { id: "a1", action: { kind: "navigate", destination: 'history."back"' } };
  assert.deepEqual(await live.tool("ditto_client_action", frame), {
    ok: true,
    result: {
      result: { type: "client_action_result", id: "a1", ok: true, summary: "Went back." },
      context: shim.context,
    },
  });
  assert.deepEqual(frames, [frame], "the frame reaches the shim intact");
  assert.deepEqual(await live.tool("ditto_client_context", {}), {
    ok: true,
    result: shim.context,
  });
  assert.deepEqual(await live.tool("ditto_client_session", { ready: true }), {
    ok: true,
    result: { shim: true },
  });
  await live.tool("ditto_client_session", { ready: false });
  assert.deepEqual(shim.ready, [true, false]);
});

test("stopping Live tells ditto-app's live actions the session is over", async () => {
  const live = fixture();
  live.bridge.startSession();
  const shim = fakeShim(async () => null);
  live.main.page = shim.page;
  await live.tool("ditto_client_session", { ready: true });
  // The aura cannot do this itself once main has disposed the bridge.
  live.bridge.stopSession("user");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shim.ready, [true, false]);
});

test("without the driver, actions relay no result and context is the route alone", async () => {
  const live = fixture();
  live.bridge.startSession();
  live.main.page = {};
  live.main.url = "app://ditto/code?task=1";
  assert.deepEqual(
    await live.tool("ditto_client_action", { id: "x", action: { kind: "open_agent" } }),
    { ok: true, result: { result: null, context: null } },
  );
  assert.deepEqual(await live.tool("ditto_client_context", {}), {
    ok: true,
    result: {
      type: "client_context",
      route: "/code?task=1",
      surface: "",
      activeAgentId: null,
      activeThreadId: null,
      destinations: [],
    },
  });
  assert.deepEqual(await live.tool("ditto_client_session", { ready: true }), {
    ok: true,
    result: { shim: false },
  });
  // A shim whose module is missing answers null the same way.
  live.main.page = fakeShim(async () => null).page;
  const old = await live.tool("ditto_client_action", { id: "y", action: { kind: "new_chat" } });
  assert.equal(old.result.result, null);
});

test("set_live_view expands to the Ditto window and leaves the orb alone", async () => {
  const live = fixture();
  live.bridge.startSession();
  const shim = fakeShim(async () => assert.fail("not forwarded"));
  live.main.page = shim.page;
  const orb = await live.tool("ditto_client_action", {
    id: "v1",
    action: { kind: "set_live_view", view: "orb" },
  });
  assert.deepEqual(orb.result, {
    result: {
      type: "client_action_result",
      id: "v1",
      ok: true,
      summary: "Live stays in the aura.",
      error: null,
      reply: null,
    },
    context: shim.context,
  });
  assert.equal(live.main.shown, false);
  const expanded = await live.tool("ditto_client_action", {
    id: "v2",
    action: { kind: "set_live_view", view: "expanded" },
  });
  assert.equal(expanded.result.result.ok, true);
  assert.equal(live.main.shown, true);
});

test("a long client action does not hold up computer tools", async () => {
  const live = fixture();
  live.bridge.startSession();
  let release;
  live.main.page = fakeShim(
    (frame) =>
      new Promise((resolve) => {
        release = () =>
          resolve({ result: { id: frame.id, ok: true, summary: "Sent.", reply: "hi" } });
      }),
  ).page;
  const prompt = live.tool("ditto_client_action", {
    id: "p1",
    action: { kind: "prompt_agent", text: "hi" },
  });
  const click = await live.tool("computer_click", { x: 1, y: 1 });
  assert.equal(click.ok, true);
  release();
  assert.equal((await prompt).result.result.reply, "hi");
});

test("Ditto window navigation and shim contexts reach the aura while Live runs", () => {
  const live = fixture();
  const commands = () => live.aura.sent.map(([, value]) => value?.type).filter(Boolean);
  const message = { type: "client_context", route: "/memory" };
  live.bridge.startSession();
  live.main.navListeners.get("did-navigate-in-page")();
  live.listeners.get("ditto-live:client-context")(live.fromMain, message);
  // Only the main window may push a context.
  live.listeners.get("ditto-live:client-context")({ sender: live.aura.webContents }, message);
  live.listeners.get("ditto-live:client-context")(
    { sender: live.main.webContents, senderFrame: { name: "iframe" } },
    message,
  );
  assert.deepEqual(commands(), ["start", "context_changed", "client_context"]);
  assert.deepEqual(live.aura.sent.at(-1)[1], { type: "client_context", message });
  live.bridge.stopSession("user");
  assert.equal(live.main.navListeners.size, 0);
  live.listeners.get("ditto-live:client-context")(live.fromMain, message);
  assert.equal(commands().filter((type) => type === "client_context").length, 1);
});

test("navigate reports the path the router lands on, not the one it left", async () => {
  const live = fixture();
  live.bridge.startSession();
  await live.tool("ditto_app", { action: "navigate", target: "code" });
  const location = { pathname: "/", search: "" };
  const link = {
    getAttribute: (name) => (name === "href" ? "/code" : null),
    // The app's router commits the new route after the click returns.
    click: () => setTimeout(() => (location.pathname = "/code")),
  };
  const page = {
    location,
    document: { querySelectorAll: () => [link] },
    history: { pushState() {} },
    dispatchEvent() {},
    PopStateEvent: class {},
    setTimeout,
  };
  assert.equal(await vm.runInNewContext(live.main.scripts.at(-1), page), "/code");
});

test("frames stay under the backend's 1 MiB read limit", async () => {
  const live = fixture();
  live.bridge.startSession();
  const portrait = { id: 1, bounds: { x: 0, y: 0, width: 1080, height: 1920 }, scaleFactor: 2 };
  const realNearest = live.electron.screen.getDisplayNearestPoint;
  live.electron.screen.getDisplayNearestPoint = () => portrait;
  await live.invoke("capture", { maxWidth: 1280 });
  assert.deepEqual(live.capturer.requests.at(-1).options.thumbnailSize, {
    width: 720,
    height: 1280,
  });
  live.electron.screen.getDisplayNearestPoint = realNearest;

  // A busy screen re-encodes at lower quality instead of dropping the socket.
  const qualities = [];
  live.state.jpeg = (quality) => {
    qualities.push(quality);
    return Buffer.alloc(quality > 40 ? 800_000 : 300_000);
  };
  const frame = await live.invoke("capture", {});
  assert.deepEqual(qualities, [60, 45, 30]);
  assert.ok(frame.data.length <= 900_000);
  live.state.jpeg = () => Buffer.alloc(800_000);
  await assert.rejects(live.invoke("capture", {}), /too large/);
});
