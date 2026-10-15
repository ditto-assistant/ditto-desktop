const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DesktopChatSync } = require("../src/chat-sync.cjs");
const sourceId = "11111111-1111-4111-8111-111111111111";
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-chat-sync-"));
  let account = "discord-account";
  let rows = [
    {
      id: "1",
      timestamp: "2026-10-01T12:00:00Z",
      content: "Synthetic QA only",
      author: { id: "bot", displayName: "QA Bot" },
    },
  ];
  const channels = {
    status: async () => ({ connected: true, user: { id: account, displayName: "QA" } }),
    conversations: async () => [{ id: "room", title: "QA", kind: "direct" }],
    messages: async () => rows,
  };
  let queue = new DesktopChatSync(directory, channels);
  t.after(() => {
    queue.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    channels,
    get queue() {
      return queue;
    },
    restart() {
      queue.close();
      queue = new DesktopChatSync(directory, channels);
    },
    setAccount(value) {
      account = value;
    },
    setRows(value) {
      rows = value;
    },
  };
}
test("opt-in source queues an exact page across restart, only receipt advances it", async (t) => {
  const f = fixture(t);
  assert.equal(await f.queue.prepare("owner"), null);
  await f.queue.select("owner", "discord", "room", true);
  const registration = await f.queue.prepare("owner");
  assert.equal(registration.kind, "register");
  assert.equal("credentials" in registration.registration, false);
  f.queue.registered("owner", registration.key, { sourceId, cursor: "" });
  const first = await f.queue.prepare("owner");
  assert.equal(first.batch.messages[0].text, "Synthetic QA only");
  f.queue.failed("owner", first.key);
  f.restart();
  assert.deepEqual((await f.queue.prepare("owner")).batch, first.batch);
  assert.throws(() => f.queue.acknowledge("owner", first.key, { sourceId, cursor: "wrong" }));
  f.queue.acknowledge("owner", first.key, { sourceId, cursor: first.batch.cursor });
  assert.equal(await f.queue.prepare("owner"), null);
  assert.equal(f.queue.status("owner")[0].queued, false);
  assert.ok(f.queue.status("owner")[0].lastSynced);
});
test("account switch, owner switch, pause and edited versions respect local consent", async (t) => {
  const f = fixture(t);
  await f.queue.select("owner", "discord", "room", true);
  let work = await f.queue.prepare("owner");
  f.queue.registered("owner", work.key, { sourceId, cursor: "" });
  work = await f.queue.prepare("owner");
  assert.equal(await f.queue.prepare("other-owner"), null);
  f.setAccount("another-account");
  assert.equal(await f.queue.prepare("owner"), null);
  f.setAccount("discord-account");
  await f.queue.select("owner", "discord", "room", false);
  assert.equal((await f.queue.prepare("owner")).kind, "pause");
  assert.equal(f.queue.status("owner")[0].queued, false);
  await f.queue.select("owner", "discord", "room", true);
  work = await f.queue.prepare("owner");
  f.queue.registered("owner", work.key, { sourceId, cursor: "" });
  work = await f.queue.prepare("owner");
  f.queue.acknowledge("owner", work.key, { sourceId, cursor: work.batch.cursor });
  f.setRows([
    {
      id: "1",
      timestamp: "2026-10-01T12:00:00Z",
      editedAt: "2026-10-01T12:01:00Z",
      content: "Edited fixture",
      author: { id: "bot", displayName: "QA Bot" },
    },
  ]);
  const edit = await f.queue.prepare("owner");
  assert.equal(edit.batch.previousCursor, work.batch.cursor);
  assert.equal(edit.batch.messages[0].text, "Edited fixture");
});
test("Discord backfill follows the oldest message only after cloud acknowledgement", async (t) => {
  const f = fixture(t);
  const calls = [];
  f.channels.messages = async (_p, _id, _limit, before) => {
    calls.push(before);
    return before
      ? []
      : Array.from({ length: 100 }, (_, i) => ({
          id: String(i + 1),
          timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(),
          content: "QA",
          author: { id: "qa", displayName: "QA" },
        }));
  };
  await f.queue.select("owner", "discord", "room", true);
  let work = await f.queue.prepare("owner");
  f.queue.registered("owner", work.key, { sourceId, cursor: "" });
  work = await f.queue.prepare("owner");
  f.restart();
  assert.deepEqual((await f.queue.prepare("owner")).batch, work.batch);
  assert.deepEqual(calls, [""]);
  f.queue.acknowledge("owner", work.key, { sourceId, cursor: work.batch.cursor });
  assert.equal(await f.queue.prepare("owner"), null);
  assert.deepEqual(calls, ["", "1"]);
});

test("pause after a lost cloud receipt reconciles the committed checkpoint without re-upload", async (t) => {
  const f = fixture(t);
  await f.queue.select("owner", "discord", "room", true);
  const registration = await f.queue.prepare("owner");
  f.queue.registered("owner", registration.key, { sourceId, cursor: "" });
  const page = await f.queue.prepare("owner");
  await f.queue.select("owner", "discord", "room", false);
  f.restart();
  await f.queue.select("owner", "discord", "room", true);
  const retry = await f.queue.prepare("owner");
  assert.equal(retry.kind, "register");
  // Server accepted the original page before the connection disappeared.
  f.queue.registered("owner", retry.key, { sourceId, cursor: page.batch.cursor });
  assert.equal(await f.queue.prepare("owner"), null);
  assert.equal(f.queue.status("owner")[0].queued, false);
});

test("one failing local account cannot starve another provider's outbox", async (t) => {
  const f = fixture(t);
  await f.queue.select("owner", "discord", "room", true);
  await f.queue.select("owner", "googlemessages", "room", true);
  const google = f.queue.status("owner").find((s) => s.provider === "googlemessages");
  f.queue.registered("owner", google.key, { sourceId, cursor: "" });
  f.channels.status = async (provider) => {
    if (provider === "discord") throw new Error("private provider diagnostics must stay local");
    return { connected: true, user: { id: "discord-account", displayName: "QA" } };
  };
  const work = await f.queue.prepare("owner");
  assert.equal(work.provider, "googlemessages");
  const failed = f.queue.status("owner").find((s) => s.provider === "discord");
  assert.ok(failed.error);
  assert.doesNotMatch(failed.error, /private provider/);
  f.restart();
  assert.equal(f.queue.status("owner").find((s) => s.provider === "discord").error, failed.error);
});

test("a local transport failure retains its queued page across restart and restoration", async (t) => {
  const f = fixture(t);
  await f.queue.select("owner", "discord", "room", true);
  const registration = await f.queue.prepare("owner");
  f.queue.registered("owner", registration.key, { sourceId, cursor: "" });
  const queued = await f.queue.prepare("owner");
  const healthyStatus = f.channels.status;
  f.channels.status = async () => {
    throw new Error("provider unavailable");
  };
  assert.equal(await f.queue.prepare("owner"), null);
  assert.equal(f.queue.status("owner")[0].queued, true);
  assert.ok(f.queue.status("owner")[0].error);
  f.restart();
  f.channels.status = healthyStatus;
  assert.deepEqual((await f.queue.prepare("owner")).batch, queued.batch);
});
