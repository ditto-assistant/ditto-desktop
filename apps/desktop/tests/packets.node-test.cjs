const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createKnowledgePacket } = require("../src/packets.cjs");

test("a selected local chat becomes a private, source-labelled coding packet", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ditto-packet-test-"));
  try {
    const channels = {
      conversations: async (service) => [
        { id: "123", title: "Build discussion", kind: "direct", service },
      ],
      messages: async () => [
        {
          id: "m1",
          timestamp: "2026-10-02T12:00:00Z",
          author: { displayName: "Peyton" },
          content: "Please change the code path.",
          attachments: [],
        },
      ],
    };
    const packet = await createKnowledgePacket(dir, channels, "discord", "123");
    const [index, transcript, manifest] = await Promise.all([
      fs.readFile(packet.path, "utf8"),
      fs.readFile(path.join(packet.folder, "transcript.md"), "utf8"),
      fs.readFile(path.join(packet.folder, "manifest.json"), "utf8").then(JSON.parse),
    ]);
    assert.match(index, /transcript\.md/);
    assert.match(transcript, /Peyton/);
    assert.match(transcript, /Please change the code path/);
    assert.equal(manifest.service, "discord");
    assert.equal(manifest.messageCount, 1);
    assert.equal((await fs.stat(packet.folder)).mode & 0o777, 0o700);
    await assert.rejects(
      createKnowledgePacket(dir, channels, "discord", "other"),
      /no longer available/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
