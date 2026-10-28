const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { LocalChannels } = require("../src/channels.cjs");

test("unconfigured Telegram never attempts restoration or login", async () => {
  const channels = new LocalChannels("/unused", "/unused");
  const calls = [];
  channels.clients.telegram.request = async (method) => {
    calls.push(method);
    if (method !== "status") throw new Error("An unconfigured client must not launch login");
    return { configured: false, connected: false };
  };
  assert.equal((await channels.status("telegram")).restoring, undefined);
  await assert.rejects(channels.startLogin("telegram"), /credentials/);
  assert.deepEqual(calls, ["status", "status"]);
});

test("Telegram restores saved sign-in again after its channel component restarts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-telegram-restart-"));
  fs.writeFileSync(
    path.join(root, "ditto-telegram-sidecar"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const input = require("node:readline").createInterface({ input: process.stdin });
let connected = false;
input.on("line", line => {
  const { id, method } = JSON.parse(line);
  if (method === "connection.restore") {
    fs.appendFileSync(path.join(process.argv[3], "restores"), "restored\\n");
    connected = true;
  }
  console.log(JSON.stringify({ id, result: { configured: true, connected } }));
});
input.on("close", () => process.exit(0));
`,
    { mode: 0o700 },
  );
  const channels = new LocalChannels(root, root);
  const children = new Set();
  t.after(async () => {
    if (channels.clients.telegram.child) children.add(channels.clients.telegram.child);
    const closed = [...children].map((child) =>
      child.exitCode === null && child.signalCode === null
        ? once(child, "close")
        : Promise.resolve(),
    );
    channels.close();
    await Promise.all(closed);
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await channels.status("telegram")).restoring, true);
  const first = channels.clients.telegram.child;
  children.add(first);
  await channels.telegramRestore;
  assert.equal((await channels.status("telegram")).connected, true);
  const exited = once(first, "close");
  first.kill("SIGTERM");
  await exited;
  assert.equal((await channels.status("telegram")).restoring, true);
  await channels.telegramRestore;
  assert.equal((await channels.status("telegram")).connected, true);
  assert.equal(fs.readFileSync(path.join(root, "restores"), "utf8"), "restored\nrestored\n");
});

test("concurrent Discord status checks share one restore operation", async () => {
  const channels = new LocalChannels("/unused", "/unused");
  const calls = [];
  channels.clients.discord.request = async (method) => {
    calls.push(method);
    await new Promise((resolve) => setImmediate(resolve));
    return { connected: method === "connection.restore" };
  };
  const states = await Promise.all([channels.status("discord"), channels.status("discord")]);
  assert.ok(states.every((s) => s.connected));
  assert.deepEqual(calls, ["status", "connection.restore"]);
});

test("disconnect clears cached conversations so the next account cannot see them", async () => {
  const channels = new LocalChannels("/unused", "/unused");
  channels.cache.set("discord", { at: Date.now(), value: [{ id: "old-account" }] });
  channels.clients.discord.request = async () => ({ connected: false });
  await channels.logout("discord");
  assert.equal(channels.cache.has("discord"), false);
});

test("a pending Discord QR survives switching away from the connection screen", async () => {
  const channels = new LocalChannels("/unused", "/unused");
  let pending = false;
  channels.clients.discord.request = async (method) => {
    if (method === "login.start") {
      pending = true;
      return { qrUrl: "https://discord.com/ra/qa", expiresInSeconds: 180 };
    }
    return { connected: false, loginPending: pending };
  };
  await channels.startLogin("discord");
  const status = await channels.status("discord");
  assert.equal(status.qrUrl, "https://discord.com/ra/qa");
  assert.ok(status.qrDataUrl.startsWith("data:image/png;base64,"));
});

for (const service of ["discord", "telegram"]) {
  for (const transition of ["logout", "login", "event"]) {
    test(`${service} rejects old conversations after account transition via ${transition}`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-channel-switch-"));
      const binary = path.join(root, `ditto-${service}-sidecar`);
      fs.writeFileSync(
        binary,
        `#!/usr/bin/env node
      const readline = require("node:readline");
      let account = "old-account";
      let pending;
      const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
      const input = readline.createInterface({ input: process.stdin });
      input.on("line", (line) => {
        const { id, method } = JSON.parse(line);
        if (method === "conversations.list" && account === "old-account") {
          pending = id;
          process.stdout.write(JSON.stringify({ event: "connection.qa-loading" }) + "\\n");
        } else if (method === "conversations.list") reply(id, [{ id: account }]);
        else if (method === "logout") { account = "new-account"; reply(id, { connected: false }); }
        else if (method === "status") reply(id, { connected: true });
        else if (method === "login.start") { account = "new-account"; reply(id, { connected: true }); }
        else if (method === "qa.switch") {
          account = "new-account";
          process.stdout.write(JSON.stringify({ event: "${service === "discord" ? "login.completed" : "connection.status"}", data: { connected: true } }) + "\\n");
          reply(id, {});
        }
        else if (method === "qa.release") { reply(pending, [{ id: "old-account" }]); reply(id, {}); }
      });
      input.on("close", () => process.exit(0));
    `,
        { mode: 0o700 },
      );
      const loading = Promise.withResolvers();
      const channels = new LocalChannels(root, root, () => loading.resolve());
      let child;
      t.after(async () => {
        const exited = child && child.exitCode === null ? once(child, "exit") : Promise.resolve();
        channels.close();
        await exited;
        fs.rmSync(root, { recursive: true, force: true });
      });
      const stale = channels.conversations(service).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      child = channels.clients[service].child;
      await loading.promise;
      if (transition === "logout") await channels.logout(service);
      else if (transition === "login") await channels.startLogin(service);
      else await channels.clients[service].request("qa.switch");
      await channels.clients[service].request("qa.release");
      const receipt = await stale;
      assert.match(receipt.error?.message || "returned old account", /connection changed/i);
      assert.equal(channels.cache.has(service), false);
      assert.deepEqual(await channels.conversations(service), [{ id: "new-account" }]);
    });
  }
}
