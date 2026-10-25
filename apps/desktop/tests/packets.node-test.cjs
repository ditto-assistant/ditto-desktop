const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { createKnowledgePacket } = require("../src/packets.cjs");

for (const service of ["discord", "telegram", "imessage", "googlemessages"])
  test(`a selected ${service} chat becomes a private, source-labelled coding packet`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ditto-packet-test-"));
    try {
      const channels = {
        conversations: async (requested) => {
          assert.equal(requested, service);
          return [{ id: "123", title: "Build discussion", kind: "direct", service }];
        },
        messages: async (requested, id, limit) => {
          assert.equal(requested, service);
          assert.equal(id, "123");
          assert.equal(limit, 80);
          return [
            {
              id: "m1",
              timestamp: "2026-10-02T12:00:00Z",
              author: { displayName: "Peyton" },
              content: "Please change the code path.",
              attachments: [],
            },
          ];
        },
      };
      const packet = await createKnowledgePacket(dir, channels, service, "123");
      const [index, transcript, manifest] = await Promise.all([
        fs.readFile(packet.path, "utf8"),
        fs.readFile(path.join(packet.folder, "transcript.md"), "utf8"),
        fs.readFile(path.join(packet.folder, "manifest.json"), "utf8").then(JSON.parse),
      ]);
      assert.match(index, /transcript\.md/);
      assert.match(transcript, /Peyton/);
      assert.match(transcript, /Please change the code path/);
      assert.equal(manifest.service, service);
      assert.match(transcript, new RegExp(`Source: ${service} on this Mac`));
      assert.equal(manifest.messageCount, 1);
      assert.equal((await fs.stat(packet.folder)).mode & 0o777, 0o700);
      for (const file of ["INDEX.md", "transcript.md", "manifest.json"])
        assert.equal((await fs.stat(path.join(packet.folder, file))).mode & 0o777, 0o600);
      assert.equal((await createKnowledgePacket(dir, channels, service, "123")).path, packet.path);
      await assert.rejects(
        createKnowledgePacket(dir, channels, service, "other"),
        /no longer available/,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

test("concurrent requests for the same chat share a complete packet without staging leftovers", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ditto-packet-concurrent-"));
  const ready = Promise.withResolvers();
  let readers = 0;
  const channels = {
    conversations: async () => [{ id: "123", title: "Concurrent chat" }],
    messages: async () => {
      if (++readers === 2) ready.resolve();
      await ready.promise;
      return [{ id: "m1", content: "One shared packet", attachments: [] }];
    },
  };
  try {
    const results = await Promise.allSettled([
      createKnowledgePacket(dir, channels, "discord", "123"),
      createKnowledgePacket(dir, channels, "discord", "123"),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    assert.equal(results[0].value.path, results[1].value.path);
    const entries = await fs.readdir(path.join(dir, "knowledge-packets"));
    assert.equal(entries.length, 1);
    assert.ok(!entries[0].startsWith(".packet-"));
    const packet = results[0].value;
    assert.match(await fs.readFile(packet.path, "utf8"), /transcript.md/);
    assert.match(
      await fs.readFile(path.join(packet.folder, "transcript.md"), "utf8"),
      /One shared packet/,
    );
    assert.equal(
      JSON.parse(await fs.readFile(path.join(packet.folder, "manifest.json"), "utf8")).messageCount,
      1,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("long local conversations retain every message reported by the packet", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ditto-packet-long-"));
  const messages = Array.from({ length: 80 }, (_, index) => ({
    id: String(index),
    author: { displayName: "Synthetic author" },
    content: `${"x".repeat(9000)} END_OF_MESSAGE_${index}`,
    attachments: [],
  }));
  try {
    const packet = await createKnowledgePacket(
      dir,
      {
        conversations: async () => [{ id: "123", title: "Long local conversation" }],
        messages: async () => messages,
      },
      "imessage",
      "123",
    );
    const transcript = await fs.readFile(path.join(packet.folder, "transcript.md"), "utf8");
    const manifest = JSON.parse(
      await fs.readFile(path.join(packet.folder, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.messageCount, messages.length);
    for (const message of messages) assert.ok(transcript.includes(message.content), message.id);
    assert.equal((transcript.match(/^## /gm) || []).length, manifest.messageCount);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("packets cached before the complete-transcript format are preserved but not reused", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ditto-packet-legacy-"));
  const messages = [{ id: "m1", content: "Complete message", attachments: [] }];
  // Version 1 keyed the cache without a format version and could truncate transcripts.
  const legacyDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ service: "imessage", conversationId: "123", messages }))
    .digest("hex")
    .slice(0, 16);
  const legacy = path.join(dir, "knowledge-packets", `imessage-Legacy-chat-${legacyDigest}`);
  try {
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, "INDEX.md"), "Legacy incomplete packet");
    const packet = await createKnowledgePacket(
      dir,
      {
        conversations: async () => [{ id: "123", title: "Legacy chat" }],
        messages: async () => messages,
      },
      "imessage",
      "123",
    );
    assert.notEqual(packet.folder, legacy);
    assert.match(
      await fs.readFile(path.join(packet.folder, "transcript.md"), "utf8"),
      /Complete message/,
    );
    assert.equal(
      await fs.readFile(path.join(legacy, "INDEX.md"), "utf8"),
      "Legacy incomplete packet",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an incomplete existing packet is preserved and cannot count as a concurrent success", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ditto-packet-incomplete-"));
  const channels = {
    conversations: async () => [{ id: "123", title: "Incomplete chat" }],
    messages: async () => [{ id: "m1", content: "Existing packet", attachments: [] }],
  };
  try {
    const packet = await createKnowledgePacket(dir, channels, "discord", "123");
    const manifestPath = path.join(packet.folder, "manifest.json");
    const manifest = await fs.readFile(manifestPath, "utf8");
    await fs.unlink(packet.path);
    await assert.rejects(createKnowledgePacket(dir, channels, "discord", "123"));
    assert.equal(await fs.readFile(manifestPath, "utf8"), manifest);
    await assert.rejects(fs.access(packet.path));
    assert.deepEqual(await fs.readdir(path.join(dir, "knowledge-packets")), [
      path.basename(packet.folder),
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
