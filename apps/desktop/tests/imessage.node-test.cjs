const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const childProcess = require("node:child_process");
const { promisify } = require("node:util");
const { createRequire } = require("node:module");
const { createKnowledgePacket } = require("../src/packets.cjs");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ditto-imessage-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "chat.db");
  await promisify(childProcess.execFile)("/usr/bin/sqlite3", [
    database,
    `
    CREATE TABLE chat (display_name TEXT, chat_identifier TEXT, style INTEGER);
    CREATE TABLE handle (id TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (text TEXT, is_from_me INTEGER, handle_id INTEGER, date INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat VALUES ('QA direct', '+15555550100', 45), ('QA group', 'chat123', 43),
      ('Ambiguous', 'chat456', 45), ('Empty', 'chat789', 45);
    INSERT INTO handle VALUES ('+15555550100'), ('+15555550101');
    INSERT INTO chat_handle_join VALUES (1,1), (2,1), (2,2), (3,1), (3,2);
    INSERT INTO message VALUES ('Incoming fixture',0,1,1000000000),
      ('Outgoing fixture',1,0,2000000000), ('Group fixture',0,2,3000000000);
    INSERT INTO chat_message_join VALUES (1,1), (1,2), (2,3);
  `,
  ]);
  const sends = [];
  const sourcePath = path.join(__dirname, "../src/channels.cjs");
  const sourceRequire = createRequire(sourcePath);
  const module = { exports: {} };
  const execFile = (command, args, options, callback) => {
    if (command !== "/usr/bin/osascript")
      return childProcess.execFile(command, args, options, callback);
    sends.push(Array.from(args.slice(-2)));
    callback(null, "", "");
  };
  execFile[promisify.custom] = (command, args, options) =>
    new Promise((resolve, reject) => {
      execFile(command, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });
  vm.runInNewContext(await fs.readFile(sourcePath, "utf8"), {
    module,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    require: (name) =>
      name === "node:child_process"
        ? {
            ...childProcess,
            execFile,
          }
        : sourceRequire(name),
  });
  const channels = new module.exports.LocalChannels("/unused", directory);
  channels.imessageDatabase = database;
  return { channels, sends, directory };
}

test("native iMessage reads identity, history and knowledge packets from a disposable SQLite database", async (t) => {
  const { channels, sends, directory } = await fixture(t);
  assert.equal((await channels.status("imessage")).connected, true);
  const rows = await channels.conversations("imessage");
  assert.equal(rows.find((row) => row.id === "1").handle, "+15555550100");
  assert.equal(rows.find((row) => row.id === "2").kind, "group");
  const history = await channels.messages("imessage", "1", 2);
  assert.deepEqual(
    Array.from(history, (message) => message.content),
    ["Incoming fixture", "Outgoing fixture"],
  );
  assert.equal(history[0].author.isSelf, false);
  assert.equal(history[1].author.isSelf, true);
  assert.equal((await channels.messages("imessage", "1", 1))[0].content, "Outgoing fixture");
  await assert.rejects(channels.messages("imessage", "1 OR 1=1"), /Invalid/);
  const packet = await createKnowledgePacket(directory, channels, "imessage", "1");
  assert.equal(packet.messageCount, 2);
  assert.match(
    await fs.readFile(path.join(packet.folder, "transcript.md"), "utf8"),
    /Outgoing fixture/,
  );
  assert.equal(sends.length, 0);
});

test("native iMessage sending rejects groups, stale recipients and unavailable chats before Messages is invoked", async (t) => {
  const { channels, sends } = await fixture(t);
  for (const [id, handle] of [
    ["2", "+15555550100"],
    ["1", "+15555550101"],
    ["3", "+15555550100"],
    ["4", "+15555550100"],
    ["999", "+15555550100"],
    ["1 OR 1=1", "+15555550100"],
  ]) {
    await assert.rejects(
      channels.send("imessage", id, "Fixture only", handle),
      /read-only|verified|Invalid/,
    );
  }
  assert.equal(sends.length, 0);
  await channels.send("imessage", "1", "Fixture only", "+15555550100");
  assert.deepEqual(sends, [["+15555550100", "Fixture only"]]);
});
