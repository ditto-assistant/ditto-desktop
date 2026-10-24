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
