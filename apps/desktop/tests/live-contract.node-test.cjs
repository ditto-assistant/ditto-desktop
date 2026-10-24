const test = require("node:test");
const assert = require("node:assert/strict");
const { registerLiveBridge } = require("../src/live/live-bridge.cjs");

// Wire contract between the aura client and backend#3795
// (pkg/api/v2/realtime_desktop_tools.go). The server frames below are built the
// way the Go relay serializes `serverMessage`, the client's replies are checked
// against the Go `clientMessage` decode and `parseRealtimeClientToolResult`,
// and every tool call runs through the real live bridge into a fake cmux
// session that validates arguments against cmux-cua 0.8.12's tool schemas.

const modules = {
  session: () => import("../src/live/client/session.js"),
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

// `serverMessage` fields are all `omitempty` strings except `Args any`: a nil
// interface is omitted, but Gemini's nil `map[string]any` is a typed nil and
// marshals as `"args":null`.
function serverFrame(fields) {
  const frame = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "args") {
      if (value !== undefined) frame.args = value;
    } else if (value !== "" && value !== undefined && value !== false && value !== 0) {
      frame[key] = value;
    }
  }
  return frame;
}

let minted = 0;
const desktopId = () =>
  `desktop-${(++minted).toString(16).padStart(8, "0")}-1f2e-4d3c-8b7a-0123456789ab`;

// `clientMessage` in realtime.go. wsjson.Read fails the whole frame (and the
// relay with it) when a known field has the wrong JSON type. Go matches field
// names case-insensitively; `ok` and `result` are json.RawMessage.
const CLIENT_FIELDS = {
  type: "string",
  data: "string",
  text: "string",
  mimetype: "string",
  id: "string",
  approved: "boolean",
  error: "string",
  ok: "raw",
  result: "raw",
};
function goDecodeClientMessage(raw) {
  const value = JSON.parse(raw);
  assert.equal(typeof value, "object");
  assert.ok(value && !Array.isArray(value), "a client frame is a JSON object");
  const message = {};
  for (const [key, field] of Object.entries(value)) {
    const kind = CLIENT_FIELDS[key.toLowerCase()];
    if (!kind) continue;
    if (kind === "raw") {
      message[key.toLowerCase()] = JSON.stringify(field);
      continue;
    }
    // A JSON null leaves a Go string or bool at its zero value.
    if (field === null) continue;
    assert.equal(typeof field, kind, `Go cannot decode ${key}=${JSON.stringify(field)}`);
    message[key.toLowerCase()] = field;
  }
  return message;
}

// Port of parseRealtimeClientToolResult + realtimeClientToolResponse.
function parseRealtimeClientToolResult(message) {
  const id = String(message.id ?? "").trim();
  if (!id) return { ok: false };
  let ok = false;
  if (message.ok !== undefined) {
    const parsed = JSON.parse(message.ok);
    ok = parsed === true;
  }
  const outcome = { OK: ok, Error: String(message.error ?? "").trim(), Result: undefined };
  if (message.result !== undefined && message.result !== "null") outcome.Result = message.result;
  if (!ok && !outcome.Error) outcome.Error = "The desktop could not complete this action.";
  return { id, outcome, ok: true };
}
function functionResponse(outcome) {
  if (!outcome.OK) return { error: outcome.Error };
  if (outcome.Result === undefined) return { result: "ok" };
  const value = JSON.parse(outcome.Result);
  return { result: typeof value === "string" ? value : outcome.Result };
}

// cmux-cua 0.8.12's own argument checks (platform-macos/src/tools/*.rs, input/keyboard.rs).
const KEY_NAMES = new Set([
  ..."return enter tab space delete backspace escape esc command cmd shift capslock option alt control ctrl fn home pageup del forward_delete end pagedown left left_arrow right right_arrow down down_arrow up up_arrow kp_0".split(
    " ",
  ),
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  ..."asdhgzxcvbqweryt123465=97-80]ou[ipl'jk;\\,/nm.`f".split(""),
]);
const MODIFIER_NAMES = new Set([
  "cmd",
  "command",
  "shift",
  "option",
  "alt",
  "ctrl",
  "control",
  "fn",
]);
const isInt = (value) => Number.isInteger(value);
const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const DELIVERY = new Set(["background", "foreground", undefined]);
const CMUX = {
  computer_get_desktop_state: () => {},
  computer_list_windows: () => {},
  computer_click(args) {
    assert.ok(isNum(args.x) && isNum(args.y) && args.x >= 0 && args.y >= 0);
    assert.equal(args.scope, "desktop");
    assert.ok(["left", "right", "middle"].includes(args.button));
    if (args.count !== undefined) assert.ok(isInt(args.count) && args.count > 0);
  },
  computer_type_text(args) {
    assert.ok(isInt(args.pid));
    assert.equal(typeof args.text, "string");
  },
  computer_press_key(args) {
    assert.ok(isInt(args.pid));
    assert.ok(KEY_NAMES.has(args.key) || args.key === "+", `cmux has no key ${args.key}`);
    for (const modifier of args.modifiers ?? []) assert.ok(MODIFIER_NAMES.has(modifier));
  },
  computer_scroll(args) {
    assert.ok(isInt(args.pid) && isInt(args.window_id));
    assert.ok(["up", "down", "left", "right"].includes(args.direction));
    assert.ok(isInt(args.amount) && args.amount >= 1 && args.amount <= 50);
    assert.ok(isNum(args.x) && isNum(args.y));
    assert.ok(DELIVERY.has(args.delivery_mode));
  },
  computer_drag(args) {
    for (const key of ["pid", "window_id"]) assert.ok(isInt(args[key]));
    for (const key of ["from_x", "from_y", "to_x", "to_y"]) assert.ok(isNum(args[key]));
    assert.ok(DELIVERY.has(args.delivery_mode));
  },
  computer_launch_app(args) {
    assert.equal(typeof args.name, "string");
  },
};

const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 };

function bridgeFixture() {
  const calls = [];
  const closed = [];
  const aura = {
    id: 2,
    sent: [],
    webContents: { mainFrame: {}, send: (channel, value) => aura.sent.push([channel, value]) },
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ x: 1300, y: 760, width: 180, height: 180 }),
    isContentProtected: () => true,
    setIgnoreMouseEvents() {},
  };
  const main = {
    id: 1,
    scripts: [],
    webContents: {
      mainFrame: {},
      send() {},
      on() {},
      removeListener() {},
      getURL: () => "https://assistant.heyditto.ai/",
      async executeJavaScript(source) {
        main.scripts.push(source);
        if (source.includes("dittoDesktopStartCode")) return { status: "started" };
        if (source.includes("v2-studio-create")) return true;
        if (source.includes("location.pathname")) return "/code";
        return null;
      },
    },
    isDestroyed: () => false,
    isMinimized: () => false,
    getTitle: () => "Ditto",
    show() {},
    focus() {},
    hide() {},
  };
  const window = {
    pid: 77,
    window_id: 9,
    layer: 0,
    bounds: { x: 0, y: 0, width: 1200, height: 900 },
  };
  const session = {
    async call(name, args) {
      const check = CMUX[name];
      assert.ok(check, `the bridge called ${name}, which Live does not use`);
      check(args);
      calls.push([name, args]);
      if (name === "computer_get_desktop_state")
        return {
          content: [{ type: "image" }],
          structuredContent: { screenshot_width: 3024, screen_width: 1512 },
        };
      if (name === "computer_list_windows")
        return { structuredContent: { windows: [{ ...window, title: "Notes" }] } };
      return { content: [{ type: "text", text: `${name} done` }] };
    },
  };
  const computer = {
    enabled: true,
    onChange() {},
    createSession: async () => ({ ...session, close: () => closed.push(true) }),
  };
  const handlers = new Map();
  const listeners = new Map();
  const bridge = registerLiveBridge({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel) => listeners.delete(channel),
    },
    computer,
    getMainWindow: () => main,
    getAuraWindow: () => aura,
    getSession: async () => ({ token: "t", sessionId: "s", wsUrl: "wss://api.example" }),
    emit() {},
    electron: {
      BrowserWindow: { getFocusedWindow: () => null },
      app: { getName: () => "Ditto Desktop", focus() {} },
      screen: {
        getCursorScreenPoint: () => ({ x: 10, y: 10 }),
        getAllDisplays: () => [DISPLAY],
        getPrimaryDisplay: () => DISPLAY,
        getDisplayNearestPoint: () => DISPLAY,
        getDisplayMatching: () => DISPLAY,
      },
      desktopCapturer: {
        getSources: async (options) => [
          {
            display_id: "1",
            thumbnail: {
              isEmpty: () => false,
              getSize: () => options.thumbnailSize,
              toJPEG: () => Buffer.from("jpeg"),
            },
          },
        ],
      },
    },
    platform: "darwin",
    pid: 4242,
    run: async (_file, args) =>
      args[0] === "front"
        ? "ASN:0x0-0x1:\n"
        : '"LSDisplayName"="Notes"\n"CFBundleIdentifier"="com.apple.Notes"\n"pid"=77\n',
  });
  const event = { sender: aura.webContents, senderFrame: aura.webContents.mainFrame };
  const invoke = (channel, ...args) => handlers.get(`ditto-live:${channel}`)(event, ...args);
  // window.dittoLive as aura-preload.cjs exposes it.
  const live = {
    session: () => invoke("session"),
    captureScreen: (options) => invoke("capture", options),
    frontmost: () => invoke("frontmost"),
    tool: (name, args) => invoke("tool", name, args),
    setState: (state) => listeners.get("ditto-live:state")(event, state),
    setInteractive() {},
    stop: (reason) => listeners.get("ditto-live:stop")(event, reason),
  };
  return { bridge, live, calls, closed, main, handlers, listeners };
}

class ContractSocket {
  static current = null;
  constructor(url) {
    this.url = new URL(url);
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.raw = [];
    this.waiters = [];
    ContractSocket.current = this;
  }
  send(raw) {
    this.raw.push(raw);
    const message = goDecodeClientMessage(raw);
    if (message.type === "stop_session")
      queueMicrotask(() => this.serve(serverFrame({ type: "session_ended" })));
    for (const waiter of this.waiters.splice(0)) waiter();
  }
  serve(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  results() {
    return this.raw.map(goDecodeClientMessage).filter((m) => m.type === "client_tool_result");
  }
  async resultFor(id) {
    for (let i = 0; i < 50; i++) {
      const found = this.results().find((m) => m.id === id);
      if (found) return found;
      await settle();
    }
    throw new Error(`no client_tool_result for ${id}`);
  }
}

async function connected(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { createLiveSession } = await modules.session();
  const fixture = bridgeFixture();
  fixture.bridge.startSession();
  const audio = {
    async start() {},
    stop() {
      audio.stopped = (audio.stopped ?? 0) + 1;
    },
    play() {},
    flush() {},
    setMuted() {},
    playbackRemainingMs: () => 0,
  };
  const session = createLiveSession({ live: fixture.live, audio, WebSocket: ContractSocket });
  await session.start();
  const socket = ContractSocket.current;
  socket.serve(serverFrame({ type: "session_started", sessionId: "rt-1", resumeToken: "" }));
  await settle();
  return { ...fixture, session, socket, audio };
}

// One desktop tool call exactly as relayGeminiBrowser + parkRealtimeClientTool
// send it, answered the way awaitRealtimeClientTool answers Gemini.
async function roundTrip(socket, name, args) {
  const geminiId = `function-call-${minted}`;
  const wireId = desktopId();
  socket.serve(serverFrame({ type: "tool_call", id: geminiId, name, args }));
  socket.serve(serverFrame({ type: "client_tool_call", id: wireId, name, args }));
  const message = await socket.resultFor(wireId);
  const parsed = parseRealtimeClientToolResult(message);
  assert.ok(parsed.ok, "the server accepts the result");
  assert.equal(parsed.id, wireId, "the minted desktop id is echoed back as-is");
  const response = functionResponse(parsed.outcome);
  socket.serve(
    serverFrame({
      type: "tool_result",
      id: geminiId,
      result: response.error ? `error: ${response.error}` : response.result,
    }),
  );
  return { message, outcome: parsed.outcome, response };
}

// Every argument shape #3795 declares (realtimeDesktopFunctions), including the
// optional fields and every documented enum spelling.
const DECLARED_CALLS = [
  ["computer_click", { x: 500, y: 500 }],
  ["computer_click", { x: 0, y: 1000, button: "right", double: true }],
  ["computer_click", { x: 1000, y: 0, button: "left", double: false }],
  ["computer_type_text", { text: "hello world" }],
  ...["return", "escape", "tab", "space", "delete", "up", "down", "left", "right", "a", "7"].map(
    (key) => ["computer_press_key", { key }],
  ),
  ["computer_press_key", { key: "c", modifiers: ["cmd"] }],
  ["computer_press_key", { key: "Return", modifiers: ["cmd", "ctrl", "option", "shift"] }],
  ...["up", "down", "left", "right"].map((direction) => [
    "computer_scroll",
    { x: 400, y: 400, direction },
  ]),
  ["computer_scroll", { x: 400, y: 400, direction: "down", amount: 10 }],
  ["computer_drag", { from_x: 100, from_y: 100, to_x: 600, to_y: 700 }],
  ...["Safari", "Notes", "Finder", "Visual Studio Code", "Café Menu"].map((name) => [
    "computer_open_app",
    { name },
  ]),
  ["computer_get_state", {}],
  ["computer_get_state", null],
  ["computer_get_state", undefined],
  ["ditto_app", { action: "show" }],
  ["ditto_app", { action: "hide" }],
  ["ditto_app", { action: "navigate", target: "code" }],
  ["ditto_app", { action: "navigate", target: "/settings" }],
  ["ditto_app", { action: "new_chat" }],
  ["ditto_app", { action: "new_chat", prompt: "Plan my week" }],
  ["ditto_app", { action: "ask_code", prompt: "Add a README" }],
];

test("every declared desktop tool shape round-trips into a result #3795 accepts", async (t) => {
  const { socket, session, calls, closed } = await connected(t);
  for (const [name, args] of DECLARED_CALLS) {
    const { message, outcome } = await roundTrip(socket, name, args);
    assert.equal(
      outcome.OK,
      true,
      `${name} ${JSON.stringify(args)} failed: ${outcome.Error || message.error}`,
    );
    assert.equal(JSON.parse(message.ok), true);
    assert.equal(message.error, undefined);
    assert.ok(message.result !== undefined, "a successful action reports what it did");
  }
  // computer_get_state answers with an object; Go forwards it as JSON text.
  const state = await roundTrip(socket, "computer_get_state", {});
  assert.match(String(state.response.result), /"frontmost"/);
  assert.ok(calls.some(([name]) => name === "computer_launch_app"));
  await session.stop();
  assert.equal(closed.length, 1, "the computer session closes with Live");
});

test("invalid arguments come back as ok:false with a string error", async (t) => {
  const { socket, session } = await connected(t);
  const bad = [
    ["computer_click", { x: 1001, y: 5 }],
    ["computer_click", { x: "500", y: 500 }],
    // On the aura itself.
    ["computer_click", { x: 919, y: 866 }],
    ["computer_type_text", {}],
    ["computer_press_key", { key: "c", modifiers: ["hyper"] }],
    ["computer_scroll", { x: 1, y: 1, direction: "sideways" }],
    ["computer_open_app", { name: "rm -rf /;" }],
    ["ditto_app", { action: "explode" }],
    ["ditto_app", { action: "navigate", target: "//evil.example/path" }],
    ["computer_teleport", {}],
    ["", {}],
  ];
  for (const [name, args] of bad) {
    const { message, outcome, response } = await roundTrip(socket, name, args);
    assert.equal(outcome.OK, false, `${name} ${JSON.stringify(args)} should fail`);
    assert.equal(typeof message.error, "string");
    assert.ok(message.error.length > 0);
    assert.equal(typeof response.error, "string");
  }
  await session.stop();
});

test("an interrupt drops queued desktop actions instead of running them", async (t) => {
  const { socket, session, calls } = await connected(t);
  const ids = [desktopId(), desktopId(), desktopId()];
  for (const [i, id] of ids.entries())
    socket.serve(
      serverFrame({
        type: "client_tool_call",
        id,
        name: "computer_type_text",
        args: { text: `step ${i}` },
      }),
    );
  socket.serve(serverFrame({ type: "interrupt" }));
  const answers = [];
  for (const id of ids) answers.push(parseRealtimeClientToolResult(await socket.resultFor(id)));
  assert.equal(answers[0].outcome.OK, true, "the action already in flight finishes");
  assert.deepEqual(
    answers.slice(1).map((answer) => answer.outcome.OK),
    [false, false],
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "computer_type_text").map(([, args]) => args.text),
    ["step 0"],
  );
  await session.stop();
});

test("session_ended, a fatal error, and a second drop all end Live on the desktop", async (t) => {
  for (const end of [
    (socket) => socket.serve(serverFrame({ type: "session_ended" })),
    (socket) =>
      socket.serve(
        serverFrame({
          type: "error",
          message: "Your token balance has been depleted. The session will end.",
        }),
      ),
  ]) {
    const { socket, session, bridge, closed, audio } = await connected(t);
    await roundTrip(socket, "computer_click", { x: 10, y: 10 });
    end(socket);
    for (let i = 0; i < 5; i++) await settle();
    assert.equal(session.active, false);
    assert.equal(bridge.active, false, "the client's stop reached the bridge");
    assert.equal(closed.length, 1, "the cursor session is closed");
    assert.ok(audio.stopped >= 1, "the mic is released");
    t.mock.timers.reset();
  }
});

test("a non-fatal server error keeps the session and its tool round-trips", async (t) => {
  const { socket, session } = await connected(t);
  socket.serve(
    serverFrame({
      type: "error",
      message: "Please send a shorter message in Live Mode (up to 4 KB).",
    }),
  );
  assert.equal(session.active, true);
  const { outcome } = await roundTrip(socket, "computer_press_key", { key: "escape" });
  assert.equal(outcome.OK, true);
  await session.stop();
});

test("every frame the client sends decodes as a Go clientMessage", async (t) => {
  const { socket, session } = await connected(t);
  t.mock.timers.tick(1000);
  await settle();
  await roundTrip(socket, "computer_get_state", {});
  await roundTrip(socket, "computer_click", { x: 2000, y: 1 });
  await session.stop();
  const types = new Set(socket.raw.map((raw) => goDecodeClientMessage(raw).type));
  for (const type of ["image", "client_tool_result", "stop_session"])
    assert.ok(types.has(type), `sent ${type}`);
});
