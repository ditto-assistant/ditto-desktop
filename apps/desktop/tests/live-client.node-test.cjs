const test = require("node:test");
const assert = require("node:assert/strict");

// Literal specifiers so knip can follow the imports.
const modules = {
  protocol: () => import("../src/live/client/protocol.js"),
  pcm: () => import("../src/live/client/pcm.js"),
  frames: () => import("../src/live/client/frames.js"),
  context: () => import("../src/live/client/context.js"),
  tools: () => import("../src/live/client/tools.js"),
  session: () => import("../src/live/client/session.js"),
  mock: () => import("../src/live/client/mock.js"),
};
const client = (name) => modules[name]();
// Lets awaited promise chains settle between fake-timer ticks.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("protocol builds the desktop realtime URL from either session shape", async () => {
  const { buildWsUrl } = await client("protocol");
  const full = new URL(
    buildWsUrl({
      wsUrl: "wss://api.example/api/v2/realtime/ws",
      token: "t k",
      sessionId: "s1",
    }),
  );
  assert.equal(full.pathname, "/api/v2/realtime/ws");
  assert.equal(full.searchParams.get("token"), "t k");
  assert.equal(full.searchParams.get("session_id"), "s1");
  assert.equal(full.searchParams.get("client"), "ditto-desktop");
  assert.equal(full.searchParams.has("activity_detection"), false);
  assert.equal(full.searchParams.has("resume_token"), false);

  const derived = new URL(
    buildWsUrl({ apiBase: "https://api.example/", token: "t", sessionId: "s", resumeToken: "r1" }),
  );
  assert.equal(derived.protocol, "wss:");
  assert.equal(derived.pathname, "/api/v2/realtime/ws");
  assert.equal(derived.searchParams.get("resume_token"), "r1");

  const origin = new URL(buildWsUrl({ wsUrl: "ws://localhost:8080", token: "t", sessionId: "s" }));
  assert.equal(origin.href.split("?")[0], "ws://localhost:8080/api/v2/realtime/ws");
  assert.throws(() => buildWsUrl({ token: "t", sessionId: "s" }));
});

test("protocol parses server frames and drops malformed or unanswerable ones", async () => {
  const { parseServerMessage, clientToolResultMessage, isFatalServerError } =
    await client("protocol");
  assert.equal(parseServerMessage("{not json"), null);
  assert.equal(parseServerMessage('"text"'), null);
  assert.equal(parseServerMessage('{"type":"something_new"}'), null);
  assert.equal(parseServerMessage('{"type":"audio"}'), null);
  assert.deepEqual(parseServerMessage('{"type":"session_started","resumeToken":"r"}'), {
    type: "session_started",
    resumed: false,
    resumeToken: "r",
  });
  assert.deepEqual(
    parseServerMessage(
      '{"type":"client_tool_call","id":"c1","name":"computer_click","args":{"x":1}}',
    ),
    { type: "client_tool_call", id: "c1", name: "computer_click", args: { x: 1 } },
  );
  assert.equal(parseServerMessage('{"type":"client_tool_call","name":"computer_click"}'), null);
  assert.deepEqual(parseServerMessage('{"type":"client_tool_call","id":"c2","args":"nope"}'), {
    type: "client_tool_call",
    id: "c2",
    name: "",
    args: {},
  });
  assert.deepEqual(parseServerMessage('{"type":"error"}'), {
    type: "error",
    message: "Live mode error",
  });

  assert.deepEqual(clientToolResultMessage("c1", { ok: true, result: { a: 1 } }), {
    type: "client_tool_result",
    id: "c1",
    ok: true,
    result: { a: 1 },
  });
  assert.deepEqual(clientToolResultMessage("c1", { ok: false }), {
    type: "client_tool_result",
    id: "c1",
    ok: false,
    error: "Tool failed",
  });
  assert.equal(isFatalServerError("Your balance is depleted"), true);
  assert.equal(isFatalServerError("Model hiccup"), false);
});

test("pcm converts, clips and round-trips through base64", async () => {
  const { float32ToInt16, int16ToBase64, base64ToInt16, int16ToFloat32 } = await client("pcm");
  const pcm = float32ToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
  assert.deepEqual(Array.from(pcm), [0, 32767, -32768, 32767, -32768, 16383]);
  assert.deepEqual(Array.from(base64ToInt16(int16ToBase64(pcm))), Array.from(pcm));
  // A trailing odd byte is not a sample.
  assert.equal(base64ToInt16(btoa("\u0001\u0002\u0003")).length, 1);
  const back = int16ToFloat32(Int16Array.from([-32768, 0, 16384]));
  assert.deepEqual(Array.from(back), [-1, 0, 0.5]);

  const big = new Int16Array(100_000).fill(1234);
  assert.equal(base64ToInt16(int16ToBase64(big)).length, 100_000);
});

test("downsampler hits 16 kHz and is seamless across worklet quanta", async () => {
  const { createDownsampler } = await client("pcm");
  for (const rate of [48000, 44100]) {
    const input = new Float32Array(rate);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 300 * i) / rate);
    const oneShot = createDownsampler(rate, 16000)(input);
    assert.ok(Math.abs(oneShot.length - 16000) <= 1, `${rate}: ${oneShot.length}`);

    const chunked = createDownsampler(rate, 16000);
    const parts = [];
    for (let i = 0; i < input.length; i += 128) parts.push(...chunked(input.subarray(i, i + 128)));
    assert.equal(parts.length, oneShot.length);
    for (let i = 0; i < parts.length; i++) assert.ok(Math.abs(parts[i] - oneShot[i]) < 1e-6);
  }
  const dc = createDownsampler(48000, 16000)(new Float32Array(480).fill(0.25));
  assert.ok(dc.every((v) => Math.abs(v - 0.25) < 1e-6));
  assert.deepEqual(Array.from(createDownsampler(16000, 16000)(Float32Array.from([0.5]))), [0.5]);
});

// Advances the mock bridge's zero-delay tool timers along with the promise chain.
async function drive(t) {
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(0);
    await settle();
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test("frame scheduler never overlaps captures and skips busy ticks", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { createFrameScheduler } = await client("frames");
  const captures = [];
  const sent = [];
  const scheduler = createFrameScheduler({
    capture: () => {
      const d = deferred();
      captures.push(d);
      return d.promise;
    },
    send: (frame) => sent.push(frame.data),
  });
  scheduler.start();
  assert.equal(captures.length, 1);
  t.mock.timers.tick(3000);
  assert.equal(captures.length, 1, "busy ticks are skipped");
  captures[0].resolve({ data: "a" });
  await settle();
  assert.deepEqual(sent, ["a"]);
  t.mock.timers.tick(1000);
  assert.equal(captures.length, 2);
  captures[1].resolve({ data: "b" });
  await settle();
  scheduler.stop();
  t.mock.timers.tick(5000);
  assert.equal(captures.length, 2);
  assert.deepEqual(sent, ["a", "b"]);
});

test("post-action frame waits for a capture that starts after the action", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { createFrameScheduler } = await client("frames");
  const captures = [];
  const sent = [];
  const scheduler = createFrameScheduler({
    capture: () => {
      const d = deferred();
      captures.push(d);
      return d.promise;
    },
    send: (frame) => sent.push(frame.data),
  });
  scheduler.start();
  let fresh = false;
  const done = scheduler.captureNow().then(() => (fresh = true));
  captures[0].resolve({ data: "stale" });
  await settle();
  assert.equal(fresh, false, "the in-flight pre-action capture does not count");
  assert.equal(captures.length, 2, "a fresh capture starts right after");
  captures[1].resolve({ data: "fresh" });
  await done;
  assert.deepEqual(sent, ["stale", "fresh"]);

  // With nothing in flight it captures immediately.
  const direct = scheduler.captureNow();
  assert.equal(captures.length, 3);
  captures[2].resolve({ data: "now" });
  await direct;
  assert.deepEqual(sent.at(-1), "now");
  scheduler.stop();
});

test("frames pause after 30 s muted and idle, and resume on activity or unmute", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { createFrameScheduler } = await client("frames");
  let count = 0;
  const scheduler = createFrameScheduler({
    capture: async () => ({ data: String(++count) }),
    send: () => {},
  });
  scheduler.start();
  await settle();
  scheduler.setMuted(true);
  for (let i = 0; i < 29; i++) {
    t.mock.timers.tick(1000);
    await settle();
  }
  const beforePause = count;
  assert.ok(beforePause >= 29);
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1000);
    await settle();
  }
  assert.equal(scheduler.isPaused(), true);
  const paused = count;
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(count, paused, "no frames while paused");
  scheduler.noteActivity();
  await settle();
  assert.equal(count, paused + 1, "activity resumes immediately");

  t.mock.timers.tick(31_000);
  await settle();
  assert.equal(scheduler.isPaused(), true);
  scheduler.setMuted(false);
  await settle();
  assert.equal(scheduler.isPaused(), false);
  assert.ok(count > paused + 1);
  scheduler.stop();
});

test("frontmost changes become context notes", async (t) => {
  const { describeFrontmost, createFrontmostWatcher } = await client("context");
  const ditto = { app: "Ditto Desktop", isDitto: true, title: "Chat" };
  const safari = { app: "Safari", bundleId: "com.apple.Safari", title: "Apple", isDitto: false };
  assert.equal(describeFrontmost(null, ditto), "User is in the Ditto app");
  assert.equal(describeFrontmost(ditto, safari), 'User is now in Safari – "Apple"');
  assert.equal(describeFrontmost(safari, { ...safari }), null);
  assert.equal(describeFrontmost(ditto, { ...ditto, title: "Settings" }), null);
  assert.equal(describeFrontmost(safari, ditto), "User returned to the Ditto app");
  assert.equal(describeFrontmost(safari, { ...safari, title: "" }), "User is now in Safari");
  assert.equal(describeFrontmost(safari, null), null);
  const long = describeFrontmost(ditto, { ...safari, title: "x".repeat(400) });
  assert.ok(long.length < 160);

  t.mock.timers.enable({ apis: ["setInterval"] });
  let current = ditto;
  const notes = [];
  const watcher = createFrontmostWatcher({
    frontmost: async () => {
      if (current === "boom") throw new Error("boom");
      return current;
    },
    onChange: (text) => notes.push(text),
  });
  await watcher.start();
  t.mock.timers.tick(1000);
  await settle();
  current = safari;
  t.mock.timers.tick(1000);
  await settle();
  current = "boom";
  t.mock.timers.tick(1000);
  await settle();
  current = safari;
  t.mock.timers.tick(1000);
  await settle();
  current = ditto;
  t.mock.timers.tick(1000);
  await settle();
  watcher.stop();
  assert.deepEqual(notes, [
    "User is in the Ditto app",
    'User is now in Safari – "Apple"',
    "User returned to the Ditto app",
  ]);
});

test("tool runner serializes calls and answers every one exactly once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { createToolRunner } = await client("tools");
  const gates = {};
  const started = [];
  const answers = [];
  const busy = [];
  const runner = createToolRunner({
    tool: (name) => {
      started.push(name);
      if (name === "throws") throw new Error("bridge exploded");
      if (name === "bad") return "nope";
      if (name === "hangs") return new Promise(() => {});
      gates[name] = deferred();
      return gates[name].promise;
    },
    respond: (id, outcome) => answers.push([id, outcome]),
    onBusyChange: (value) => busy.push(value),
  });
  runner.handle({ id: "1", name: "first", args: {} });
  runner.handle({ id: "2", name: "second", args: {} });
  await settle();
  assert.deepEqual(started, ["first"], "second waits for first");
  gates.first.resolve({ ok: true, result: "clicked" });
  await settle();
  assert.deepEqual(started, ["first", "second"]);
  gates.second.resolve({ ok: false, error: "No permission" });
  await settle();
  runner.handle({ id: "3", name: "throws", args: {} });
  runner.handle({ id: "4", name: "bad", args: {} });
  runner.handle({ id: "5", name: "", args: {} });
  runner.handle({ id: "6", name: "hangs", args: {} });
  await settle();
  t.mock.timers.tick(25_000);
  await settle();
  assert.deepEqual(answers, [
    ["1", { ok: true, result: "clicked" }],
    ["2", { ok: false, error: "No permission", result: undefined }],
    ["3", { ok: false, error: "bridge exploded" }],
    ["4", { ok: false, error: "Tool returned an invalid response" }],
    ["5", { ok: false, error: "Tool call has no name" }],
    ["6", { ok: false, error: "hangs timed out after 25000 ms" }],
  ]);
  assert.equal(busy[0], true);
  assert.equal(busy.at(-1), false);
  assert.equal(runner.isBusy(), false);
});

test("closing the tool runner answers queued and in-flight calls", async () => {
  const { createToolRunner } = await client("tools");
  const gate = deferred();
  const answers = [];
  const runner = createToolRunner({
    tool: () => gate.promise,
    respond: (id, outcome) => answers.push([id, outcome.ok, outcome.error]),
  });
  runner.handle({ id: "a", name: "computer_click", args: {} });
  runner.handle({ id: "b", name: "computer_click", args: {} });
  await settle();
  runner.close();
  runner.handle({ id: "c", name: "computer_click", args: {} });
  gate.resolve({ ok: true });
  await settle();
  assert.deepEqual(answers, [
    ["b", false, "Live session ended"],
    ["c", false, "Live session ended"],
    ["a", false, "Live session ended"],
  ]);
});

class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = new URL(url);
    this.readyState = 1;
    this.sent = [];
    FakeSocket.all.push(this);
  }
  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.type === "stop_session")
      queueMicrotask(() => this.serve({ type: "session_ended" }));
  }
  serve(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

function fakeAudio() {
  return {
    started: 0,
    stopped: 0,
    played: [],
    flushed: 0,
    muted: false,
    onChunk: null,
    async start({ onChunk }) {
      this.started++;
      this.onChunk = onChunk;
    },
    stop() {
      this.stopped++;
    },
    play(data) {
      this.played.push(data);
    },
    flush() {
      this.flushed++;
    },
    setMuted(value) {
      this.muted = value;
    },
    playbackRemainingMs: () => 0,
  };
}

async function startSession(t, overrides = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  FakeSocket.all = [];
  const { createLiveSession } = await client("session");
  const { createMockLive } = await client("mock");
  const live = createMockLive({ toolDelayMs: 0 });
  const audio = fakeAudio();
  const states = [];
  const session = createLiveSession({
    live,
    audio,
    WebSocket: FakeSocket,
    onState: (s) => states.push(s),
    ...overrides,
  });
  await session.start();
  return { session, live, audio, states, socket: FakeSocket.all[0] };
}

test("session connects as the desktop client and streams once started", async (t) => {
  const { session, live, audio, states, socket } = await startSession(t);
  assert.equal(socket.url.searchParams.get("client"), "ditto-desktop");
  assert.equal(socket.url.searchParams.get("token"), "mock-token");
  assert.equal(socket.url.searchParams.get("session_id"), "mock-session");
  assert.deepEqual(states, ["connecting"]);
  audio.onChunk("AAAA");
  assert.deepEqual(socket.sent, [], "nothing is sent before session_started");

  socket.serve({ type: "session_started", resumeToken: "r1" });
  await settle();
  assert.equal(session.state, "listening");
  audio.onChunk("AAAA");
  assert.ok(socket.types().includes("image"), "first frame goes out on start");
  assert.ok(socket.types().includes("context"));
  assert.deepEqual(
    socket.sent.find((m) => m.type === "audio"),
    { type: "audio", data: "AAAA" },
  );

  socket.serve({ type: "audio", data: "AAAA" });
  assert.equal(session.state, "speaking");
  assert.deepEqual(audio.played, ["AAAA"]);
  t.mock.timers.tick(300);
  assert.equal(session.state, "listening");
  socket.serve({ type: "transcript", role: "user", text: "hi" });
  assert.equal(session.state, "thinking");
  t.mock.timers.tick(8000);
  assert.equal(session.state, "listening", "silent model does not spin forever");
  socket.serve({ type: "transcript", role: "user", text: "hi" });
  socket.serve({ type: "interrupt" });
  assert.equal(audio.flushed, 1);
  assert.equal(session.state, "listening");
  assert.equal(live.state, "listening");

  await settle();
  live.switchApp(1);
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(
    socket.sent.findLast((m) => m.type === "context"),
    {
      type: "context",
      text: 'User is now in Safari – "Apple"',
    },
  );
  await session.stop();
});

test("client tool calls act, send a fresh frame, then answer", async (t) => {
  const { session, live, socket } = await startSession(t);
  socket.serve({ type: "session_started" });
  await settle();
  socket.sent.length = 0;
  socket.serve({
    type: "client_tool_call",
    id: "c1",
    name: "computer_click",
    args: { x: 10, y: 20 },
  });
  assert.equal(session.state, "acting");
  await drive(t);
  assert.deepEqual(
    live.calls.find((c) => c[0] === "tool"),
    ["tool", "computer_click", { x: 10, y: 20 }],
  );
  assert.deepEqual(socket.types(), ["image", "client_tool_result"]);
  assert.deepEqual(socket.sent[1], {
    type: "client_tool_result",
    id: "c1",
    ok: true,
    result: { done: "computer_click" },
  });
  assert.equal(session.state, "thinking");

  socket.serve({ type: "client_tool_call", id: "c2", name: "computer_fail", args: {} });
  await drive(t);
  assert.deepEqual(socket.sent.at(-1), {
    type: "client_tool_result",
    id: "c2",
    ok: false,
    error: "Mock failure",
  });
  await session.stop();
});

test("one bounded reconnect resumes, a second drop ends the session", async (t) => {
  const { session, live, audio, states } = await startSession(t);
  const first = FakeSocket.all[0];
  first.serve({ type: "session_started", resumeToken: "r1" });
  await settle();
  first.serve({ type: "session_resumption_ready", resumeToken: "r2" });
  first.close();
  assert.equal(session.state, "connecting");
  t.mock.timers.tick(750);
  await settle();
  const second = FakeSocket.all[1];
  assert.equal(second.url.searchParams.get("resume_token"), "r2");
  assert.equal(second.url.searchParams.get("client"), "ditto-desktop");
  second.serve({ type: "session_started", resumed: true });
  await settle();
  assert.equal(session.state, "listening");

  // The budget refills after a successful reconnect, but a reconnect that
  // never establishes ends the session.
  second.close();
  t.mock.timers.tick(750);
  await settle();
  FakeSocket.all[2].close();
  await settle();
  assert.equal(session.active, false);
  assert.equal(audio.stopped, 1);
  assert.equal(states.at(-1), "error");
  assert.deepEqual(
    live.calls.filter((c) => c[0] === "stop"),
    [["stop", "disconnected"]],
  );
});

test("stop sends stop_session, releases everything, and answers parked calls", async (t) => {
  const { session, live, audio } = await startSession(t, {});
  const socket = FakeSocket.all[0];
  socket.serve({ type: "session_started" });
  await settle();
  live.tool = () => new Promise(() => {});
  socket.serve({ type: "client_tool_call", id: "c1", name: "computer_click", args: {} });
  socket.serve({ type: "client_tool_call", id: "c2", name: "computer_click", args: {} });
  await settle();
  const stopping = session.stop("user");
  await stopping;
  assert.deepEqual(
    socket.sent.filter((m) => m.type === "client_tool_result").map((m) => [m.id, m.ok]),
    [["c2", false]],
  );
  assert.ok(socket.types().includes("stop_session"));
  assert.equal(socket.readyState, 3);
  assert.equal(audio.stopped, 1);
  assert.equal(session.state, "idle");
  assert.deepEqual(
    live.calls.filter((c) => c[0] === "stop"),
    [["stop", "user"]],
  );

  const frameCount = live.calls.filter((c) => c[0] === "captureScreen").length;
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(live.calls.filter((c) => c[0] === "captureScreen").length, frameCount);
});

test("server session_ended and fatal errors tear down; others only flash", async (t) => {
  const { session, live, socket } = await startSession(t);
  socket.serve({ type: "session_started" });
  await settle();
  socket.serve({ type: "error", message: "Model hiccup" });
  assert.equal(session.state, "error");
  t.mock.timers.tick(2000);
  assert.equal(session.state, "listening");
  socket.serve({ type: "session_ended" });
  await settle();
  assert.equal(session.active, false);
  assert.equal(socket.types().includes("stop_session"), false);
  assert.deepEqual(
    live.calls.filter((c) => c[0] === "stop"),
    [["stop", "session_ended"]],
  );

  // A restart works on the same session object.
  await session.start();
  const next = FakeSocket.all.at(-1);
  next.serve({ type: "session_started" });
  await settle();
  next.serve({ type: "error", message: "Your balance is depleted" });
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(session.active, false);
  assert.equal(live.calls.findLast((c) => c[0] === "stop")[1], "error: Your balance is depleted");
});

test("mute stops sending mic audio and feeds the idle frame pause", async (t) => {
  const { session, audio, socket } = await startSession(t);
  socket.serve({ type: "session_started" });
  await settle();
  session.setMuted(true);
  assert.equal(audio.muted, true);
  assert.equal(session.muted, true);
  for (let i = 0; i < 35; i++) {
    t.mock.timers.tick(1000);
    await settle();
  }
  const images = socket.sent.filter((m) => m.type === "image").length;
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(socket.sent.filter((m) => m.type === "image").length, images);
  session.setMuted(false);
  await settle();
  assert.equal(socket.sent.filter((m) => m.type === "image").length, images + 1);
  await session.stop();
});

test("a microphone failure ends the session as an error", async (t) => {
  const audio = fakeAudio();
  audio.start = async () => {
    throw new Error("Permission denied");
  };
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  FakeSocket.all = [];
  const { createLiveSession } = await client("session");
  const { createMockLive } = await client("mock");
  const live = createMockLive();
  const session = createLiveSession({ live, audio, WebSocket: FakeSocket });
  await session.start();
  assert.equal(FakeSocket.all.length, 0);
  assert.equal(session.active, false);
  assert.equal(live.state, "error");
  assert.deepEqual(live.calls.at(-1), ["stop", "error: Permission denied"]);
});
