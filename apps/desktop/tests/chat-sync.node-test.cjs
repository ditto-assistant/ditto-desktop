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

for (const provider of ["discord", "googlemessages"]) {
  for (const change of ["pause", "disconnect"]) {
    test(`${provider} history cannot queue after ${change} during the final account check`, async (t) => {
      const f = fixture(t);
      await f.queue.select("owner", provider, "room", true);
      const registration = await f.queue.prepare("owner");
      f.queue.registered("owner", registration.key, { sourceId, cursor: "" });
      const checking = Promise.withResolvers();
      const resume = Promise.withResolvers();
      const healthyStatus = f.channels.status;
      let connected = true;
      let checks = 0;
      f.channels.status = async () => {
        if (++checks === 2) {
          checking.resolve();
          await resume.promise;
        }
        return { ...(await healthyStatus()), connected };
      };
      const preparing = f.queue.prepare("owner");
      await checking.promise;
      if (change === "pause") await f.queue.select("owner", provider, "room", false);
      else connected = false; // A disconnected provider may retain its cached identity.
      resume.resolve();
      assert.equal(await preparing, null, "stale history must not become upload work");
      assert.equal(f.queue.status("owner")[0].queued, false);
      f.restart();
      if (change === "pause") {
        assert.equal(f.queue.status("owner")[0].chats[0].enabled, false);
        assert.equal((await f.queue.prepare("owner")).kind, "pause");
        await f.queue.select("owner", provider, "room", true);
        const retry = await f.queue.prepare("owner");
        assert.equal(retry.kind, "register");
        f.queue.registered("owner", retry.key, { sourceId, cursor: "" });
      } else {
        assert.equal(await f.queue.prepare("owner"), null);
        connected = true;
      }
      const recovered = await f.queue.prepare("owner");
      assert.equal(recovered.kind, "ingest");
      assert.equal(recovered.provider, provider);
      assert.equal(recovered.batch.messages[0].text, "Synthetic QA only");
    });
  }
}

for (const provider of ["discord", "googlemessages"]) {
  for (const resumed of [false, true]) {
    test(`${provider} late ${resumed ? "resume" : "initial"} registration receipt preserves a newer pause across restart`, async (t) => {
      const f = fixture(t);
      await f.queue.select("owner", provider, "room", true);
      let registration = await f.queue.prepare("owner");
      if (resumed) {
        f.queue.registered("owner", registration.key, { sourceId, cursor: "" });
        const page = await f.queue.prepare("owner");
        assert.equal(page.kind, "ingest");
        await f.queue.select("owner", provider, "room", false);
        const pause = await f.queue.prepare("owner");
        assert.equal(pause.kind, "pause");
        f.queue.paused("owner", pause.key);
        await f.queue.select("owner", provider, "room", true);
        registration = await f.queue.prepare("owner");
      }
      assert.equal(registration.kind, "register");
      const response = Promise.withResolvers();
      const applying = response.promise.then((receipt) =>
        f.queue.registered("owner", registration.key, receipt),
      );
      // The cloud registration is already in flight when local consent changes.
      await f.queue.select("owner", provider, "room", false);
      response.resolve({ sourceId, cursor: "" });
      await applying;
      assert.equal(f.queue.status("owner")[0].chats[0].enabled, false);
      assert.equal(f.queue.status("owner")[0].queued, false);
      f.restart();
      const pause = await f.queue.prepare("owner");
      assert.equal(pause?.kind, "pause", "the server must still receive the newer pause");
      assert.equal(pause.sourceId, sourceId);
      f.queue.paused("owner", pause.key);
      f.restart();
      assert.equal(await f.queue.prepare("owner"), null);
    });
  }

  test(`${provider} late pause receipt preserves a newer resume before any upload`, async (t) => {
    const f = fixture(t);
    await f.queue.select("owner", provider, "room", true);
    const registration = await f.queue.prepare("owner");
    f.queue.registered("owner", registration.key, { sourceId, cursor: "" });
    const original = await f.queue.prepare("owner");
    await f.queue.select("owner", provider, "room", false);
    const pause = await f.queue.prepare("owner");
    assert.equal(pause.kind, "pause");
    const response = Promise.withResolvers();
    const applying = response.promise.then(() => f.queue.paused("owner", pause.key));
    await f.queue.select("owner", provider, "room", true);
    response.resolve();
    await applying;
    f.restart();
    const resume = await f.queue.prepare("owner");
    assert.equal(resume?.kind, "register", "resume cloud consent before returning any page");
    assert.equal(f.queue.status("owner")[0].chats[0].enabled, true);
    // The pause cancelled the old page; registration reconciles its checkpoint.
    f.queue.registered("owner", resume.key, { sourceId, cursor: "" });
    const page = await f.queue.prepare("owner");
    assert.equal(page.kind, "ingest");
    assert.notEqual(page.batch.cursor, original.batch.cursor);
    assert.deepEqual(page.batch.messages, original.batch.messages);
    f.queue.acknowledge("owner", page.key, { sourceId, cursor: page.batch.cursor });
    f.restart();
    assert.equal(await f.queue.prepare("owner"), null);
    assert.equal(f.queue.status("owner")[0].queued, false);
  });
}
