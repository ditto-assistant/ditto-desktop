const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(overrides = {}) {
  const source = fs.readFileSync(path.join(__dirname, "../src/desktop-shell.js"), "utf8");
  const body = acorn.parse(source, { ecmaVersion: "latest" }).body[0].expression.callee.body.body;
  const controller = body.find(
    (node) => node.type === "FunctionDeclaration" && node.id.name === "createDesktopAccountLink",
  );
  const timers = new Map();
  let sequence = 0;
  let state;
  let changes = 0;
  let cancels = 0;
  let signouts = 0;
  const polls = [];
  const bridge = {
    status: async () => ({ accountLinked: false }),
    linkStart: async () => ({ userCode: "QA-CODE", intervalSeconds: 2 }),
    linkPoll: async () => polls.shift(),
    linkCancel: async () => {
      ++cancels;
    },
    signOut: async () => {
      ++signouts;
    },
    ...overrides,
  };
  const context = {
    bridge,
    render: (next) => {
      state = next;
    },
    changed: () => {
      ++changes;
    },
    desktopError: (error) => error.message,
    setTimeout: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  const api = vm.runInNewContext(
    `(${source.slice(controller.start, controller.end)})(bridge, render, changed)`,
    context,
  );
  return {
    api,
    polls,
    timers,
    get state() {
      return state;
    },
    get changes() {
      return changes;
    },
    get cancels() {
      return cancels;
    },
    get signouts() {
      return signouts;
    },
    async tick() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.callback();
      return timer.delay;
    },
  };
}

test("desktop approval honors pending and slow-down before updating connected services", async () => {
  const f = fixture();
  await f.api.refresh();
  assert.equal(f.state.linked, false);
  await f.api.start();
  assert.equal(f.state.busy, true);
  assert.match(f.state.message, /QA-CODE/);
  f.polls.push({ kind: "pending" }, { kind: "slow-down" }, { kind: "linked" });
  assert.equal(await f.tick(), 2000);
  assert.equal(await f.tick(), 2000);
  assert.equal(await f.tick(), 7000);
  assert.equal(f.state.linked, true);
  assert.equal(f.state.busy, false);
  assert.equal(f.changes, 1);
  assert.equal(f.timers.size, 0);
  await f.api.disconnect();
  assert.equal(f.signouts, 1);
  assert.equal(f.state.linked, false);
  assert.equal(f.changes, 2);
});

for (const kind of ["expired", "denied"])
  test(`${kind} approval stops polling and allows another attempt`, async () => {
    const f = fixture();
    await f.api.start();
    f.polls.push({ kind });
    await f.tick();
    assert.equal(f.state.busy, false);
    assert.equal(f.state.linked, false);
    assert.equal(f.changes, 0);
    assert.equal(f.timers.size, 0);
    await f.api.start();
    assert.equal(f.state.busy, true);
  });

test("cancelled browser startup cannot schedule stale polling or sign out an account", async () => {
  const started = deferred();
  const f = fixture({ linkStart: () => started.promise });
  const request = f.api.start();
  await f.api.cancel();
  started.resolve({ userCode: "OLD", intervalSeconds: 2 });
  await request;
  assert.equal(f.cancels, 1);
  assert.equal(f.signouts, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.state.busy, false);
  assert.match(f.state.message, /cancelled/);
});

test("late approval and initial status cannot override a cancellation or new attempt", async () => {
  const status = deferred();
  const poll = deferred();
  const f = fixture({ status: () => status.promise, linkPoll: () => poll.promise });
  const refreshing = f.api.refresh();
  await f.api.start();
  const polling = f.tick();
  await f.api.cancel();
  await f.api.start();
  poll.resolve({ kind: "linked" });
  status.resolve({ accountLinked: true });
  await Promise.all([polling, refreshing]);
  assert.equal(f.state.busy, true);
  assert.equal(f.state.linked, false);
  assert.equal(f.changes, 0);
  assert.equal(f.timers.size, 1);
});

test("failed connection reports the error and can retry", async () => {
  let attempts = 0;
  const f = fixture({
    linkStart: async () => {
      if (++attempts === 1) throw new Error("Network unavailable");
      return { userCode: "RETRY" };
    },
  });
  await f.api.start();
  assert.equal(f.state.busy, false);
  assert.match(f.state.message, /Network unavailable/);
  await f.api.start();
  assert.equal(f.state.busy, true);
  assert.match(f.state.message, /RETRY/);
});
