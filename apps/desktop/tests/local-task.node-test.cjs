const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const net = require("node:net");
const os = require("node:os");
const { spawnLocalTask, cancelLocalTask, wasLocalTaskCancelled } = require("../src/local-task.cjs");

function fixture(script) {
  return spawnLocalTask(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

async function closeTask(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  cancelLocalTask(child);
  await closed;
}

test(
  "Stop drains a task group even when its launcher exits 143 and a tool ignores SIGTERM",
  { skip: os.platform() === "win32", timeout: 10000 },
  async (t) => {
    const tool = `
    const net = require('node:net');
    process.on('SIGTERM', () => {});
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => process.send({port:server.address().port}));
  `;
    const child = fixture(`
    const {spawn} = require('node:child_process');
    process.on('SIGTERM', () => process.exit(143));
    const tool = spawn(process.execPath, ['-e', ${JSON.stringify(tool)}], {stdio:['ignore','inherit','inherit','ipc']});
    tool.on('message', (message) => process.send(message));
  `);
    t.after(() => closeTask(child));
    const [ready] = await once(child, "message");
    const sibling = fixture("process.send('ready'); setInterval(() => {}, 1000);");
    t.after(() => closeTask(sibling));
    await once(sibling, "message");
    const closed = once(child, "close");
    assert.equal(cancelLocalTask(child), true);
    const [code] = await closed;
    assert.equal(code, 143);
    assert.equal(wasLocalTaskCancelled(child), true);
    assert.equal(sibling.exitCode, null);
    assert.equal(sibling.signalCode, null);
    const socket = net.connect({ host: "127.0.0.1", port: ready.port });
    t.after(() => socket.destroy());
    const [error] = await once(socket, "error");
    assert.equal(error.code, "ECONNREFUSED");
  },
);

test(
  "Stop escalates when the task itself ignores SIGTERM",
  { skip: os.platform() === "win32", timeout: 10000 },
  async (t) => {
    const child = fixture(
      "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);",
    );
    t.after(() => closeTask(child));
    await once(child, "message");
    const closed = once(child, "close");
    cancelLocalTask(child);
    const [, signal] = await closed;
    assert.equal(signal, "SIGKILL");
    assert.equal(wasLocalTaskCancelled(child), true);
  },
);

test("an ordinary nonzero exit is not cancellation, and a completed task is not signalled", async () => {
  const child = fixture("process.exit(143)");
  const [code] = await once(child, "close");
  assert.equal(code, 143);
  assert.equal(wasLocalTaskCancelled(child), false);
  assert.equal(cancelLocalTask(child), false);
  assert.equal(wasLocalTaskCancelled(child), false);
});
