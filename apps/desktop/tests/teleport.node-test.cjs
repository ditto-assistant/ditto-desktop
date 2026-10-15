const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

test("Desktop previews local workspaces without an account but keeps transfers authenticated", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-teleport-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = new EventEmitter();
  const paths = { appData: root };
  app.isPackaged = true;
  app.setName = () => {};
  app.getPath = (name) => paths[name];
  app.setPath = (name, value) => {
    paths[name] = value;
  };
  app.whenReady = () => new Promise(() => {});
  const settings = new Map();
  const handlers = new Map();
  const sourcePath = path.join(__dirname, "../src/main.cjs");
  const load = createRequire(sourcePath);
  let cliCalls = 0;
  vm.runInNewContext(
    fs.readFileSync(sourcePath, "utf8") +
      `
      store = fixtureStore;
      registerIpc();
    `,
    {
      __dirname: path.dirname(sourcePath),
      process,
      Buffer,
      fixtureStore: {
        getSetting: (name, fallback) => settings.get(name) ?? fallback,
        setSetting: (name, value) => settings.set(name, value),
      },
      require(name) {
        if (name === "electron")
          return {
            app,
            ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
          };
        if (name === "./remote.cjs") {
          const remote = load(name);
          return {
            ...remote,
            runCli: (...args) => {
              cliCalls++;
              return remote.runCli(...args);
            },
          };
        }
        if (name.startsWith("./") && name !== "./workspace.cjs") return {};
        return load(name);
      },
    },
    { filename: sourcePath },
  );
  const preview = handlers.get("ditto:teleport-plan");
  const empty = await preview();
  assert.equal(empty.root, fs.realpathSync(path.join(paths.userData, "workspaces/default")));
  assert.equal(empty.repos.length, 0);
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  fs.writeFileSync(path.join(project, "package.json"), '{"name":"teleport-qa","private":true}');
  settings.set("workspace", project);
  const plan = await preview();
  assert.equal(plan.root, fs.realpathSync(project));
  assert.equal(plan.repos.length, 1);
  assert.equal(cliCalls, 2);
  for (const args of [[false], [true, "personal"]]) {
    await assert.rejects(handlers.get("ditto:teleport-push")(null, ...args), /Sign in with Ditto/);
  }
  await assert.rejects(handlers.get("ditto:teleport-list")(), /Sign in with Ditto/);
  assert.equal(cliCalls, 2, "Unauthenticated cloud operations must not launch the CLI");
  assert.equal(fs.existsSync(path.join(paths.userData, "ditto-account.json")), false);
});
