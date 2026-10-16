const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter, once } = require("node:events");
const { MemoryStore } = require("../src/memory.cjs");
const { spawnLocalTask, cancelLocalTask, wasLocalTaskCancelled } = require("../src/local-task.cjs");

function desktopFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-local-quit-"));
  const data = path.join(root, "data");
  const store = new MemoryStore(data);
  store.setSetting("workspace", root);
  let storeClosed = false;
  let databaseClosed = false;
  const close = store.close.bind(store);
  store.close = () => {
    storeClosed = true;
    // Keep a broken shutdown fixture drainable; the test still fails its close-order check.
    if (!store.recentPiRuns().some((run) => run.status === "running")) {
      close();
      databaseClosed = true;
    }
  };
  const app = new EventEmitter();
  app.isPackaged = true;
  app.setName = () => {};
  const paths = { appData: root, userData: data };
  app.getPath = (name) => paths[name];
  app.setPath = (name, value) => {
    paths[name] = value;
  };
  app.whenReady = () => new Promise(() => {});
  let didQuit;
  const quit = new Promise((resolve) => {
    didQuit = resolve;
  });
  app.quit = () => {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    app.emit("before-quit", event);
    if (!event.prevented) didQuit();
    return event;
  };
  const handlers = new Map();
  let child;
  let spawnCount = 0;
  let ready;
  let didStart;
  const started = new Promise((resolve) => {
    didStart = resolve;
  });
  const start = () => {
    spawnCount++;
    child = spawnLocalTask(
      process.execPath,
      [
        "-e",
        `
      process.on('SIGTERM', () => process.exit(143));
      process.on('disconnect', () => process.exit(0));
      console.log(JSON.stringify({type:'message_update', assistantMessageEvent:{type:'text_delta',delta:'Partial QA reply'}}));
      process.send('ready');
      setInterval(() => {}, 1000);
    `,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    ready = once(child, "message");
    didStart();
    return child;
  };
  const sourcePath = path.join(__dirname, "../src/main.cjs");
  const sourceRequire = createRequire(sourcePath);
  const source = fs.readFileSync(sourcePath, "utf8");
  vm.runInNewContext(
    source +
      `
    store = fixtureStore;
    engineMaintenance = {active:false};
    remoteHost = fixtureRemoteHost;
    piStatus = fixtureStatus;
    openHarness = async () => null;
    registerIpc();
  `,
    {
      __dirname: path.dirname(sourcePath),
      process,
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      setImmediate,
      fixtureStore: store,
      fixtureRemoteHost: options.remoteHost,
      fixtureStatus: options.status || (async () => ({ ready: true, localModel: null })),
      require(name) {
        if (name === "electron")
          return {
            app,
            ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
            dialog: { showErrorBox() {} },
          };
        if (name === "./code-providers.cjs")
          return {
            startProvider: () => {
              const running = start();
              return {
                child: running,
                result: once(running, "close").then(() => ({
                  text: "Partial QA reply",
                  cancelled: wasLocalTaskCancelled(running),
                })),
              };
            },
          };
        if (name === "./pi-sandbox.cjs") return { spawnSandboxedPi: start };
        if (name === "./browser-agent.cjs")
          return {
            startAgentBrowser: options.browser || (async () => ({ close: async () => {} })),
          };
        if (
          name.startsWith("./") &&
          !["./memory.cjs", "./task-context.cjs", "./local-task.cjs", "./workspace.cjs"].includes(
            name,
          )
        )
          return {};
        return sourceRequire(name);
      },
    },
    { filename: sourcePath },
  );
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      cancelLocalTask(child);
      await closed;
    }
    if (!databaseClosed) close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    app,
    handlers,
    quit,
    data,
    started,
    spawnCount: () => spawnCount,
    ready: () => ready,
    closed: () => storeClosed,
    databaseClosed: () => databaseClosed,
  };
}

for (const provider of ["pi", "codex"])
  test(
    `Quit waits for the ${provider} task's cancellation receipt before closing SQLite`,
    { timeout: 10000 },
    async (t) => {
      const fixture = desktopFixture(t);
      let executionError;
      const running = (
        provider === "pi"
          ? fixture.handlers.get("ditto:chat")(null, "Reply exactly QA. Do not retrieve memories.")
          : fixture.handlers.get("ditto:run-provider")(
              null,
              "codex",
              "Reply exactly QA. Do not retrieve memories.",
            )
      ).catch((error) => {
        executionError = error;
      });
      // The Pi path first awaits model, memory and browser setup.
      await Promise.race([
        fixture.started,
        running.then(() => {
          throw executionError || new Error("Task ended before spawning");
        }),
      ]);
      await fixture.ready();
      const event = fixture.app.quit();
      assert.equal(event.prevented, true, "Keep Desktop alive until its local run is saved");
      assert.equal(fixture.closed(), false);
      assert.equal(
        fixture.app.quit().prevented,
        true,
        "Repeated Quit still waits for the same run",
      );
      await fixture.quit;
      await running;
      assert.equal(executionError, undefined);
      assert.equal(fixture.closed(), true);
      assert.equal(fixture.databaseClosed(), true);
      const reopened = new MemoryStore(fixture.data);
      try {
        const runs = reopened.recentPiRuns();
        assert.equal(runs.length, 1);
        assert.equal(runs[0].status, "cancelled");
        assert.equal(runs[0].response, "Partial QA reply");
        assert.equal(runs[0].error, "");
      } finally {
        reopened.close();
      }
    },
  );

test("Quit without a local task closes SQLite immediately", async (t) => {
  const fixture = desktopFixture(t);
  assert.equal(fixture.app.quit().prevented, false);
  await fixture.quit;
  assert.equal(fixture.closed(), true);
});

function setupGate() {
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const result = new Promise((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: () => {
      enter();
      return result;
    },
  };
}

test(
  "Stop during model setup prevents a later launch and releases local ownership",
  { timeout: 10000 },
  async (t) => {
    const gate = setupGate();
    const fixture = desktopFixture(t, { status: gate.wait });
    const running = fixture.handlers.get("ditto:chat")(
      null,
      "Reply exactly QA. Do not retrieve memories.",
    );
    await gate.entered;
    const stopped = await fixture.handlers.get("ditto:cancel-chat")();
    gate.release({ ready: true, localModel: null });
    // Drain the broken baseline too, without leaving its unexpectedly launched child behind.
    if (!stopped) {
      await fixture.started;
      await fixture.ready();
      await fixture.handlers.get("ditto:cancel-chat")();
    }
    const response = await running;
    assert.equal(stopped, true, "Stop must also own a task that has no child yet");
    assert.equal(response.cancelled, true);
    assert.equal(fixture.spawnCount(), 0);
  },
);

test(
  "pending startup blocks competing tasks and folder changes until cancellation drains",
  { timeout: 10000 },
  async (t) => {
    const gate = setupGate();
    const fixture = desktopFixture(t, { status: gate.wait });
    const running = fixture.handlers.get("ditto:chat")(
      null,
      "Reply exactly QA. Do not retrieve memories.",
    );
    await gate.entered;
    try {
      await assert.rejects(
        fixture.handlers.get("ditto:chat")(null, "Another task"),
        /already working/,
      );
      await assert.rejects(
        fixture.handlers.get("ditto:run-provider")(null, "codex", "Another task"),
        /already running/,
      );
      await assert.rejects(fixture.handlers.get("ditto:choose-workspace")(), /Stop the local task/);
      await assert.rejects(
        async () => fixture.handlers.get("ditto:default-workspace")(),
        /Stop the local task/,
      );
    } finally {
      await fixture.handlers.get("ditto:cancel-chat")();
      gate.release({ ready: true, localModel: null });
    }
    assert.equal((await running).cancelled, true);
    assert.equal(fixture.spawnCount(), 0);
    const folder = await fixture.handlers.get("ditto:default-workspace")();
    assert.ok(folder.endsWith(path.join("workspaces", "default")));
    const retry = fixture.handlers.get("ditto:chat")(
      null,
      "Reply exactly QA. Do not retrieve memories.",
    );
    await fixture.started;
    await fixture.ready();
    assert.equal(await fixture.handlers.get("ditto:cancel-chat")(), true);
    assert.equal((await retry).cancelled, true);
    assert.equal(fixture.spawnCount(), 1);
  },
);

test(
  "Quit during setup saves cancellation before closing SQLite without launching a child",
  { timeout: 10000 },
  async (t) => {
    const gate = setupGate();
    const fixture = desktopFixture(t, { status: gate.wait });
    const running = fixture.handlers.get("ditto:chat")(
      null,
      "Reply exactly QA. Do not retrieve memories.",
    );
    await gate.entered;
    assert.equal(fixture.app.quit().prevented, true);
    assert.equal(fixture.app.quit().prevented, true);
    assert.equal(fixture.closed(), false);
    gate.release({ ready: true, localModel: null });
    assert.equal((await running).cancelled, true);
    await fixture.quit;
    assert.equal(fixture.spawnCount(), 0);
    assert.equal(fixture.databaseClosed(), true);
    const reopened = new MemoryStore(fixture.data);
    try {
      const runs = reopened.recentPiRuns();
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, "cancelled");
      assert.equal(runs[0].response, "");
      assert.equal(runs[0].error, "");
    } finally {
      reopened.close();
    }
  },
);

test(
  "Stop while the browser bridge initializes closes it before returning cancellation",
  { timeout: 10000 },
  async (t) => {
    const gate = setupGate();
    let bridgeClosed = 0;
    const fixture = desktopFixture(t, { browser: gate.wait });
    const running = fixture.handlers.get("ditto:chat")(
      null,
      "Reply exactly QA. Do not retrieve memories.",
    );
    await gate.entered;
    assert.equal(await fixture.handlers.get("ditto:cancel-chat")(), true);
    gate.release({
      close: async () => {
        bridgeClosed++;
      },
    });
    assert.equal((await running).cancelled, true);
    assert.equal(bridgeClosed, 1);
    assert.equal(fixture.spawnCount(), 0);
  },
);

test(
  "failed model setup releases ownership so a later local task can start",
  { timeout: 10000 },
  async (t) => {
    let attempts = 0;
    const fixture = desktopFixture(t, {
      status: async () => {
        if (++attempts === 1) throw new Error("Synthetic setup failure");
        return { ready: true, localModel: null };
      },
    });
    await assert.rejects(
      fixture.handlers.get("ditto:chat")(null, "Reply exactly QA. Do not retrieve memories."),
      /Synthetic setup failure/,
    );
    const running = fixture.handlers.get("ditto:chat")(
      null,
      "Reply exactly QA. Do not retrieve memories.",
    );
    await fixture.started;
    await fixture.ready();
    assert.equal(await fixture.handlers.get("ditto:cancel-chat")(), true);
    assert.equal((await running).cancelled, true);
  },
);

for (const setupPending of [false, true]) {
  test(
    `Quit drains Remote Control with local startup pending=${setupPending}`,
    { timeout: 10000 },
    async (t) => {
      const child = spawnLocalTask(
        process.execPath,
        [
          "-e",
          `
    process.on("SIGTERM", () => {});
    process.on("disconnect", () => process.exit(0));
    process.send("remote-ready");
    setInterval(() => {}, 1000);
  `,
        ],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      const exited = once(child, "close");
      t.after(async () => {
        cancelLocalTask(child);
        await exited;
      });
      await once(child, "message");
      const remoteHost = {
        child,
        stop() {
          cancelLocalTask(this.child);
        },
      };
      child.once("close", () => {
        remoteHost.child = null;
      });
      const gate = setupGate();
      const fixture = desktopFixture(t, {
        remoteHost,
        ...(setupPending ? { status: gate.wait } : {}),
      });
      const starting = setupPending
        ? fixture.handlers.get("ditto:chat")(null, "Reply exactly QA. Do not retrieve memories.")
        : null;
      if (setupPending) await gate.entered;
      const quit = fixture.app.quit();
      assert.equal(quit.prevented, true, "keep Electron alive until Remote Control is stopped");
      assert.equal(fixture.closed(), false);
      assert.equal(fixture.app.quit().prevented, true, "repeated Quit shares the same shutdown");
      if (setupPending) {
        gate.release({ ready: true, localModel: null });
        assert.equal((await starting).cancelled, true);
        assert.equal(fixture.spawnCount(), 0);
      }
      await fixture.quit;
      await exited;
      assert.equal(child.signalCode, "SIGKILL", "the unresponsive child needed bounded escalation");
      assert.equal(remoteHost.child, null);
      assert.equal(fixture.databaseClosed(), true);
    },
  );
}
