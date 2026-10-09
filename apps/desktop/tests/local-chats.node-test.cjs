const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { stripTypeScriptTypes } = require("node:module");

const model = import(
  "data:text/javascript;base64," +
    Buffer.from(
      stripTypeScriptTypes(
        fs.readFileSync(path.join(__dirname, "../renderer/local-chat-model.ts"), "utf8"),
      ),
    ).toString("base64")
);

test("local messages retain provider identity, replies, media, and UTC iMessage dates", async () => {
  const api = await model;
  const message = api.localConnectorMessage("imessage", "42", {
    id: "99",
    content: "Hello",
    timestamp: "2026-10-09 14:22:31",
    replyToId: "98",
    author: { id: "me", displayName: "You", isSelf: true },
    attachments: [
      { filename: "photo.png", contentType: "image/png", url: "https://cdn.example/photo.png" },
      { filename: "private.txt", url: "file:///Users/someone/private.txt" },
    ],
  });
  assert.equal(message.isFromSelf, true);
  assert.equal(message.senderName, "You");
  assert.equal(message.sentAt, "2026-10-09T14:22:31Z");
  assert.equal(message.replyToMessageId, "desktop-local:imessage:42:message:98");
  assert.equal(message.attachments[0].type, "image");
  assert.equal(message.attachments[1].url, "");
  assert.notEqual(api.localSessionID("discord", "42"), api.localSessionID("telegram", "42"));
  assert.notEqual(api.localSessionID("discord", "42"), "42");
});

test("a local send stays with the original native account and chat during navigation", async () => {
  const api = await model;
  let complete;
  const calls = [];
  const bridge = {
    channelSend: (...args) => {
      calls.push(args);
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
  };
  const selection = {
    service: "discord",
    conversation: { id: "one", title: "One", kind: "direct" },
  };
  const send = api.sendLocalMessage(bridge, selection, "  Message  ");
  selection.service = "telegram";
  selection.conversation = { id: "two", title: "Two", kind: "direct" };
  complete({});
  await send;
  assert.deepEqual(calls, [["discord", "one", "Message", undefined]]);
});

test("unsupported local sends cannot silently discard attachments or send to an iMessage group", async () => {
  const api = await model;
  let count = 0;
  const bridge = {
    channelSend: async () => {
      count++;
    },
  };
  const direct = {
    service: "imessage",
    conversation: { id: "42", title: "Friend", kind: "direct", handle: "+15555550100" },
  };
  await assert.rejects(api.sendLocalMessage(bridge, direct, "Photo", { files: [{}] }), /text only/);
  await assert.rejects(
    api.sendLocalMessage(
      bridge,
      { ...direct, conversation: { ...direct.conversation, kind: "group" } },
      "Hello",
    ),
    /read-only/,
  );
  await assert.rejects(api.sendLocalMessage(bridge, direct, " "), /Enter a message/);
  assert.equal(count, 0);
  await api.sendLocalMessage(bridge, direct, "Hello");
  assert.equal(count, 1);
});

test("leaving a local chat removes its IPC listener without affecting other subscribers", () => {
  const ipc = new EventEmitter();
  let api;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/preload.cjs"), "utf8"), {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_name, value) => {
          api = value;
        },
      },
      ipcRenderer: ipc,
    }),
  });
  let first = 0,
    second = 0;
  const leave = api.onChannelEvent(() => first++);
  const leaveSecond = api.onChannelEvent(() => second++);
  ipc.emit("ditto:channel-event", {}, { event: "message.created" });
  leave();
  ipc.emit("ditto:channel-event", {}, { event: "message.created" });
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(ipc.listenerCount("ditto:channel-event"), 1);
  leaveSecond();
  assert.equal(ipc.listenerCount("ditto:channel-event"), 0);
});
