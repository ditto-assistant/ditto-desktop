const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AURA_SIZE,
  clampAuraPosition,
  createLiveController,
  createTokenRequester,
  liveStopNotice,
} = require("../src/live/aura-controller.cjs");

const primary = { x: 0, y: 25, width: 1440, height: 875 };
const left = { x: -1920, y: 0, width: 1920, height: 1080 };

test("aura position stays on the display it was saved on", () => {
  assert.deepEqual(clampAuraPosition({ x: -900, y: 400 }, [primary, left]), { x: -900, y: 400 });
  // Half hanging off the right edge of the primary display.
  assert.deepEqual(clampAuraPosition({ x: 1300, y: 10 }, [primary, left]), {
    x: 1440 - AURA_SIZE,
    y: 25,
  });
  // Straddling two displays clamps into the one holding its center.
  assert.deepEqual(clampAuraPosition({ x: -100, y: 500 }, [primary, left]), {
    x: -AURA_SIZE,
    y: 500,
  });
});

test("aura falls back to the primary corner without a usable saved position", () => {
  const corner = { x: 1440 - AURA_SIZE - 24, y: 25 + 875 - AURA_SIZE - 24 };
  assert.deepEqual(clampAuraPosition(null, [primary]), corner);
  assert.deepEqual(clampAuraPosition({ x: Number.NaN, y: 3 }, [primary]), corner);
  // The external display it was saved on is gone.
  assert.deepEqual(clampAuraPosition({ x: -900, y: 400 }, [primary]), corner);
});

function fixture({ enabled = true, prepare, open } = {}) {
  const events = [];
  const controller = createLiveController({
    isComputerEnabled: async () => enabled,
    openComputerSetup: () => events.push("setup"),
    prepare: prepare ?? (async () => events.push("prepare")),
    open: open ?? (async (id) => events.push(`open:${id}`)),
    close: async (reason) => events.push(`close:${reason}`),
    onActive: (active) => events.push(`active:${active}`),
    newSessionId: (() => {
      let next = 0;
      return () => `session-${++next}`;
    })(),
  });
  return { controller, events };
}

test("live opens Computer Use setup instead of starting while it is off", async () => {
  const { controller, events } = fixture({ enabled: false });
  assert.deepEqual(await controller.start(), { started: false, reason: "computer-disabled" });
  assert.equal(controller.state, "idle");
  assert.deepEqual(events, ["setup"]);
});

test("toggle starts and stops one live session at a time", async () => {
  const { controller, events } = fixture();
  assert.deepEqual(await controller.toggle(), { started: true, sessionId: "session-1" });
  assert.equal(controller.state, "active");
  assert.deepEqual(await controller.start(), { started: false, reason: "running" });
  assert.equal(await controller.toggle(), true);
  assert.equal(await controller.stop(), false);
  assert.deepEqual(await controller.toggle(), { started: true, sessionId: "session-2" });
  assert.deepEqual(events, [
    "active:true",
    "prepare",
    "open:session-1",
    "active:false",
    "close:toggle",
    "active:true",
    "prepare",
    "open:session-2",
  ]);
});

test("a stop while the aura opens tears down the late window", async () => {
  let finishOpen;
  const { controller, events } = fixture({
    open: () =>
      new Promise((resolve) => {
        finishOpen = resolve;
      }),
  });
  const starting = controller.start();
  await new Promise(setImmediate);
  assert.equal(controller.state, "starting");
  await controller.stop("computer-disabled");
  finishOpen();
  assert.deepEqual(await starting, { started: false, reason: "stopped" });
  assert.equal(controller.state, "idle");
  assert.deepEqual(events, [
    "active:true",
    "prepare",
    "active:false",
    "close:computer-disabled",
    "close:stopped",
  ]);
});

test("a stopped opening session drains before another Live session can start", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let opens = 0;
  const { controller } = fixture({
    open: async () => {
      if (++opens === 1) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const first = controller.start();
  await entered.promise;
  await controller.stop("lock-screen");
  assert.deepEqual(await controller.start(), { started: false, reason: "running" });
  release.resolve();
  assert.deepEqual(await first, { started: false, reason: "stopped" });
  assert.deepEqual(await controller.start(), { started: true, sessionId: "session-2" });
  assert.equal(controller.state, "active");
  assert.equal(opens, 2);
  await controller.stop();
});

test("an opening failure after Stop still closes resources created after the first cleanup", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let visible = false;
  const closed = [];
  const controller = createLiveController({
    isComputerEnabled: () => true,
    openComputerSetup() {},
    open: async () => {
      entered.resolve();
      await release.promise;
      visible = true;
      throw new Error("The stopped bridge is no longer available.");
    },
    close: (reason) => {
      closed.push(reason);
      visible = false;
    },
  });
  const first = controller.start();
  await entered.promise;
  await controller.stop("suspend");
  release.resolve();
  assert.deepEqual(await first, { started: false, reason: "stopped" });
  assert.equal(visible, false);
  assert.equal(controller.state, "idle");
  assert.deepEqual(closed, ["suspend", "stopped"]);
});

test("a failed sign-in check closes nothing open and reports the error", async () => {
  const { controller, events } = fixture({
    prepare: async () => {
      throw new Error("Sign in to Ditto Desktop before starting Live.");
    },
  });
  await assert.rejects(controller.start(), /Sign in/);
  assert.equal(controller.state, "idle");
  assert.deepEqual(events, ["active:true", "active:false", "close:start-failed"]);
});

test("token requests resolve only by their own id and time out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  let next = 0;
  const tokens = createTokenRequester({
    send: (id) => sent.push(id) > 0,
    timeoutMs: 1000,
    newId: () => `request-${++next}`,
  });
  const first = tokens.request();
  const second = tokens.request();
  assert.equal(tokens.resolve("request-9", { token: "stray" }), false);
  tokens.resolve("request-2", { token: "fixture-token" });
  assert.equal(await second, "fixture-token");
  t.mock.timers.tick(1000);
  await assert.rejects(first, /Sign in/);
  assert.equal(tokens.resolve("request-1", { token: "late" }), false);
  const signedOut = tokens.request();
  tokens.resolve("request-3", { error: "Sign in to Ditto Desktop before starting Live." });
  await assert.rejects(signedOut, /Sign in/);
  assert.deepEqual(sent, ["request-1", "request-2", "request-3"]);
});

test("the signed-in renderer answers token requests and refuses when signed out", async () => {
  const { answerDesktopLiveTokens } = await import("../renderer/desktopLive.ts");
  const replies = [];
  let stops = 0;
  let request;
  global.window = {
    ditto: {
      onLiveTokenRequest: (listener) => {
        request = listener;
        return () => {
          request = null;
        };
      },
      liveTokenReply: (id, reply) => replies.push([id, reply]),
      liveStop: async () => stops++,
    },
  };
  try {
    const stop = answerDesktopLiveTokens(null);
    request("a");
    stop();
    assert.equal(request, null);
    answerDesktopLiveTokens({ getIdToken: async () => "fixture-token" });
    request("b");
    await new Promise(setImmediate);
    assert.deepEqual(replies, [
      ["a", { error: "Sign in to Ditto Desktop before starting Live." }],
      ["b", { token: "fixture-token" }],
    ]);
    assert.equal(stops, 1, "signing out stops a running Live session");
  } finally {
    delete global.window;
  }
});

test("only a failed live session explains why the aura went away", () => {
  for (const reason of ["user", "aura-button", "toggle", "command", "session_ended", "quit"])
    assert.equal(liveStopNotice(reason), null);
  assert.match(liveStopNotice("disconnected"), /lost its connection/);
  assert.match(liveStopNotice("resume_unavailable"), /could not resume/);
  assert.equal(liveStopNotice("error: Microphone is blocked"), "Microphone is blocked");
});

// aura-window.cjs talks to Electron directly; this stands in for the pieces it uses.
function loadAuraWindow() {
  const Module = require("node:module");
  const windows = [];
  class FakeWebContents {
    constructor() {
      this.listeners = new Map();
    }
    on(name, listener) {
      this.listeners.set(name, listener);
    }
    emit(name, ...args) {
      this.listeners.get(name)?.({}, ...args);
    }
    setWindowOpenHandler() {}
  }
  class FakeBrowserWindow {
    constructor() {
      this.webContents = new FakeWebContents();
      this.events = new Map();
      this.destroyed = false;
      this.hidden = false;
      windows.push(this);
    }
    on(name, listener) {
      this.events.set(name, listener);
    }
    once(name, listener) {
      this.events.set(name, listener);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.events.get("closed")?.();
    }
    hide() {
      this.hidden = true;
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setContentProtection() {}
    setIgnoreMouseEvents() {}
    async loadFile() {}
  }
  const display = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  const electron = {
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      listeners: new Map(),
      on(channel, listener) {
        this.listeners.set(channel, listener);
      },
      removeListener(channel, listener) {
        if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
      },
    },
    session: {
      fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }),
    },
    systemPreferences: { getMediaAccessStatus: () => "granted" },
    screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] },
  };
  const path = require.resolve("../src/live/aura-window.cjs");
  delete require.cache[path];
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === "electron" ? electron : load.call(this, request, ...rest);
  };
  try {
    return { ...require(path), windows, ipcMain: electron.ipcMain };
  } finally {
    Module._load = load;
  }
}

test("an aura that crashes, reloads or closes on its own stops Live; a stop does not", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { createAuraWindow, windows, ipcMain } = loadAuraWindow();
  const gone = [];
  const aura = createAuraWindow({
    getSetting: () => null,
    setSetting() {},
    onGone: (reason) => gone.push(reason),
  });

  await aura.open();
  windows[0].webContents.emit("did-finish-load");
  windows[0].webContents.emit("render-process-gone", { reason: "crashed" });
  windows[0].webContents.emit("did-finish-load");
  assert.deepEqual(gone, ["aura-crashed", "aura-reloaded"]);
  windows[0].destroy();
  assert.deepEqual(gone, ["aura-crashed", "aura-reloaded", "aura-closed"]);
  assert.equal(aura.window, null);

  // Live's own stop hides at once and destroys once the client has sent
  // stop_session (or after the grace period); none of it reports the aura as gone.
  gone.length = 0;
  await aura.open();
  aura.close();
  assert.equal(windows[1].hidden, true);
  assert.equal(windows[1].destroyed, false);
  assert.equal(aura.window, null);
  t.mock.timers.tick(1500);
  assert.equal(windows[1].destroyed, true);
  // The client's own stop report ends the wait early.
  await aura.open();
  aura.dispose();
  ipcMain.listeners.get("ditto-live:stop")({ sender: windows[2].webContents });
  assert.equal(windows[2].destroyed, true);
  assert.deepEqual(gone, []);
});
