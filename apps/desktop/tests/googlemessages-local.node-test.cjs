const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GoogleMessagesLocal } = require("../src/googlemessages-local.cjs");
const secureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s.split("").reverse().join("")),
  decryptString: (b) => b.toString().split("").reverse().join(""),
};
test("Google Messages pairing stays local, restores credentials and stores pages before cursor advancement", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-googlemessages-"));
  let transport = new GoogleMessagesLocal(root, root, secureStorage, async () => ({
    status: "cancelled",
  }));
  t.after(() => {
    transport.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const calls = [];
  transport.request = async (route, body) => {
    calls.push({ route, body });
    if (route === "/v1/connect")
      return body.credentials.flowID
        ? { credentials: { session: "synthetic-session" }, displayName: "QA Android" }
        : {
            challenge: {
              kind: "qr",
              prompt: "https://example.com/qa-pairing",
              state: { flowID: "qa-flow" },
            },
          };
    return {
      nextCursor: "provider-page-1",
      threads: [
        {
          threadId: "qa-room",
          threadName: "QA",
          threadKind: "dm",
          lastMessageAt: "2026-10-01T12:00:00Z",
        },
      ],
      messages: [
        {
          messageId: "1",
          threadId: "qa-room",
          timestamp: "2026-10-01T12:00:00Z",
          text: "Synthetic only",
          senderId: "qa",
          senderName: "QA",
        },
      ],
    };
  };
  const status = await transport.login();
  assert.equal(status.connected, true);
  assert.equal(status.user.displayName, "QA Android");
  const conversations = await transport.conversations();
  assert.equal(conversations[0].title, "QA");
  assert.equal((await transport.messages("qa-room"))[0].content, "Synthetic only");
  assert.equal(calls.at(-1).body.cursor, "provider-page-1");
  assert.ok(!fs.readFileSync(transport.accountFile()).toString().includes("synthetic-session"));
  const id = status.user.id;
  transport.close();
  transport = new GoogleMessagesLocal(root, root, secureStorage, async () => ({
    status: "cancelled",
  }));
  assert.equal((await transport.status()).user.id, id);
  assert.equal(fs.statSync(transport.accountFile()).mode & 0o777, 0o600);
  await transport.logout();
  assert.equal((await transport.status()).connected, false);
});
test(
  "bundled Google Messages bridge starts only on loopback and requires its local bearer token",
  { skip: !fs.existsSync(path.join(__dirname, "../native/bin/ditto-google-messages-bridge")) },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-googlemessages-bind-"));
    const transport = new GoogleMessagesLocal(
      path.join(__dirname, "../native/bin"),
      root,
      secureStorage,
      async () => ({ status: "cancelled" }),
    );
    t.after(() => {
      transport.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await transport.start();
    assert.equal(new URL(transport.base).hostname, "127.0.0.1");
    const response = await fetch(transport.base + "/v1/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    const child = transport.child;
    const { execFileSync } = require("node:child_process");
    const sockets = execFileSync(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-p", String(child.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
      { encoding: "utf8" },
    );
    assert.match(sockets, /n127\.0\.0\.1:/);
    assert.doesNotMatch(sockets, /n\*:/);
  },
);

test("cancelled Google Messages pairing cannot restore a late sign-in response", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-googlemessages-cancel-"));
  const transport = new GoogleMessagesLocal(root, root, secureStorage, async () => ({
    status: "cancelled",
  }));
  t.after(() => {
    transport.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let complete;
  transport.request = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const attempt = transport.login();
  await new Promise((resolve) => setImmediate(resolve));
  transport.cancelLogin();
  complete({ credentials: { session: "must-not-be-saved" }, displayName: "QA" });
  assert.equal((await attempt).connected, false);
  assert.equal(fs.existsSync(transport.accountFile()), false);
});
