const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-account-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = new EventEmitter();
  app.isPackaged = true;
  app.setName = () => {};
  const paths = { appData: root };
  app.getPath = (name) => paths[name];
  app.setPath = (name, value) => {
    paths[name] = value;
  };
  app.whenReady = () => new Promise(() => {});
  const handlers = new Map();
  const requests = [];
  const browser = [];
  const sourcePath = path.join(__dirname, "../src/main.cjs");
  const sourceRequire = createRequire(sourcePath);
  const context = {
    __dirname: path.dirname(sourcePath),
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    fixtureStore: { setSetting() {} },
    fixtureDevices: { stop() {} },
    fixtureRemoteHost: { stop() {} },
    fixturePost(route, body) {
      const response = deferred();
      requests.push({ route, body, response });
      return response.promise;
    },
    require(name) {
      if (name === "electron")
        return {
          app,
          ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
          dialog: { showErrorBox() {} },
          shell: {
            openExternal: async (url) => {
              browser.push(url);
            },
          },
          // Deliberately fake encryption: no system Keychain or real credential access.
          safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (value) => Buffer.from(value),
            decryptString: (value) => value.toString(),
          },
        };
      if (name === "node:fs/promises" && options.writeGate) {
        const files = sourceRequire(name);
        return {
          ...files,
          async writeFile(...args) {
            options.writeGate.entered.resolve();
            await options.writeGate.release.promise;
            return files.writeFile(...args);
          },
        };
      }
      if (name.startsWith("./")) return {};
      return sourceRequire(name);
    },
  };
  vm.runInNewContext(
    fs.readFileSync(sourcePath, "utf8") +
      `
    store = fixtureStore;
    devices = fixtureDevices;
    remoteHost = fixtureRemoteHost;
    postDitto = fixturePost;
    registerIpc();
  `,
    context,
    { filename: sourcePath },
  );
  return {
    call: (name) => handlers.get(`ditto:${name}`)(),
    requests,
    browser,
    account: path.join(paths.userData, "ditto-account.json"),
  };
}

function startResponse(code) {
  return {
    status: 200,
    data: {
      device_code: code,
      user_code: `QA-${code}`,
      verification_url: "https://example.invalid/desktop-qa",
      expires_in: 600,
    },
  };
}
async function start(f, code) {
  const pending = f.call("link-start");
  f.requests.at(-1).response.resolve(startResponse(code));
  await pending;
}

test("a token response after sign-out cannot restore Desktop credentials", async (t) => {
  const f = fixture(t);
  await start(f, "old");
  const poll = f.call("link-poll");
  const request = f.requests.at(-1);
  await f.call("sign-out");
  request.response.resolve({ status: 200, data: { access_token: "ditto_mcp_synthetic_old" } });
  assert.equal((await poll).kind, "expired");
  assert.equal(fs.existsSync(f.account), false);
});

for (const response of [
  { access_token: "ditto_mcp_synthetic_old" },
  { error: "access_denied" },
  { error: "expired_token" },
])
  test(`an old poll (${Object.keys(response)[0]} ${response.error || "success"}) preserves the newer sign-in`, async (t) => {
    const f = fixture(t);
    await start(f, "old");
    const oldPoll = f.call("link-poll");
    const oldRequest = f.requests.at(-1);
    await start(f, "new");
    oldRequest.response.resolve({ status: 200, data: response });
    assert.equal((await oldPoll).kind, "expired");
    assert.equal(fs.existsSync(f.account), false);
    const newPoll = f.call("link-poll");
    assert.equal(f.requests.at(-1).body.device_code, "new");
    f.requests
      .at(-1)
      .response.resolve({ status: 200, data: { access_token: "ditto_mcp_synthetic_new" } });
    assert.equal((await newPoll).kind, "linked");
    assert.equal(
      Buffer.from(JSON.parse(fs.readFileSync(f.account, "utf8")).key, "base64").toString(),
      "ditto_mcp_synthetic_new",
    );
    await f.call("sign-out");
    assert.equal(fs.existsSync(f.account), false);
  });

test("sign-out cancels a device-code request before it opens a browser", async (t) => {
  const f = fixture(t);
  const starting = f.call("link-start");
  const request = f.requests.at(-1);
  await f.call("sign-out");
  request.response.resolve(startResponse("old"));
  await assert.rejects(starting, /cancelled/i);
  assert.equal(f.browser.length, 0);
  assert.equal((await f.call("link-poll")).kind, "expired");
});

test("out-of-order start responses cannot replace the latest device code", async (t) => {
  const f = fixture(t);
  const starting = f.call("link-start");
  const request = f.requests.at(-1);
  await start(f, "new");
  request.response.resolve(startResponse("old"));
  await assert.rejects(starting, /cancelled/i);
  assert.equal(f.browser.length, 1);
  const poll = f.call("link-poll");
  assert.equal(f.requests.at(-1).body.device_code, "new");
  f.requests.at(-1).response.resolve({ status: 200, data: { error: "authorization_pending" } });
  assert.equal((await poll).kind, "pending");
});

for (const action of ["sign-out", "new sign-in"])
  test(
    `${action} during credential file writing cancels the commit`,
    { timeout: 5000 },
    async (t) => {
      const writeGate = { entered: deferred(), release: deferred() };
      const f = fixture(t, { writeGate });
      await start(f, "old");
      const poll = f.call("link-poll");
      f.requests
        .at(-1)
        .response.resolve({ status: 200, data: { access_token: "ditto_mcp_synthetic_old" } });
      await writeGate.entered.promise;
      try {
        if (action === "sign-out") await f.call("sign-out");
        else await start(f, "new");
      } finally {
        writeGate.release.resolve();
      }
      assert.equal((await poll).kind, "expired");
      assert.equal(fs.existsSync(f.account), false);
      assert.equal(
        fs.readdirSync(path.dirname(f.account)).length,
        0,
        "Remove the cancelled staging file",
      );
      if (action === "new sign-in") {
        const nextPoll = f.call("link-poll");
        assert.equal(f.requests.at(-1).body.device_code, "new");
        f.requests
          .at(-1)
          .response.resolve({ status: 200, data: { access_token: "ditto_mcp_synthetic_new" } });
        assert.equal((await nextPoll).kind, "linked");
        assert.equal(fs.statSync(f.account).mode & 0o777, 0o600);
      }
    },
  );

for (const [error, kind] of [
  ["authorization_pending", "pending"],
  ["slow_down", "slow-down"],
  ["access_denied", "denied"],
  ["expired_token", "expired"],
])
  test(`the current sign-in still handles ${error}`, async (t) => {
    const f = fixture(t);
    await start(f, "current");
    const poll = f.call("link-poll");
    f.requests.at(-1).response.resolve({ status: 400, data: { error } });
    assert.equal((await poll).kind, kind);
    assert.equal(fs.existsSync(f.account), false);
    if (kind === "denied" || kind === "expired") {
      const requestCount = f.requests.length;
      assert.equal((await f.call("link-poll")).kind, "expired");
      assert.equal(f.requests.length, requestCount);
    }
  });
