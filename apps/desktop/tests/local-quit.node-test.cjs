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

function desktopFixture(t) {
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
  let ready;
  let didStart;
  const started = new Promise((resolve) => {
    didStart = resolve;
  });
  const start = () => {
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
    piStatus = async () => ({ready:true,localModel:null});
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
          return { startAgentBrowser: async () => ({ close: async () => {} }) };
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
