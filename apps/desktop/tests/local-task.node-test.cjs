const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
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
  "provider interrupt lets its owner drain detached tools before exiting",
  { skip: os.platform() === "win32", timeout: 10000 },
  async (t) => {
    const tool = `
      const net = require('node:net');
      const server = net.createServer();
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
      server.listen(0, '127.0.0.1', () => process.send({port: server.address().port}));
    `;
    const child = spawnLocalTask(
      process.execPath,
      [
        "-e",
        `
          const {spawn} = require('node:child_process');
          const tool = spawn(process.execPath, ['-e', ${JSON.stringify(tool)}], {
            detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc']
          });
          tool.on('message', message => process.send(message));
          for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
            tool.once('close', () => process.exit(signal === 'SIGINT' ? 130 : 143));
            tool.kill('SIGTERM');
          });
        `,
      ],
      {
        cancelSignal: "SIGINT",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    t.after(() => closeTask(child));
    const [ready] = await once(child, "message");
    const closed = once(child, "close");
    assert.equal(cancelLocalTask(child), true);
    assert.equal((await closed)[0], 130);
    assert.equal(wasLocalTaskCancelled(child), true);
    const socket = net.connect({ host: "127.0.0.1", port: ready.port });
    t.after(() => socket.destroy());
    assert.equal((await once(socket, "error"))[0].code, "ECONNREFUSED");
  },
);

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

test("post-exit cleanup denial reports a task error instead of escaping the exit handler", () => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 12345, exitCode: null, signalCode: null });
  const denied = Object.assign(new Error("Fixture signal denied"), { code: "EPERM" });
  const signals = [];
  const target = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/local-task.cjs"), "utf8"), {
    module: target,
    require: (name) => {
      if (name === "node:child_process") return { spawn: () => child };
      if (name === "node:os") return { platform: () => "darwin" };
      throw new Error(`Unexpected fixture import: ${name}`);
    },
    process: {
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === "SIGKILL") throw denied;
      },
    },
    setTimeout,
    clearTimeout,
  });
  const tasks = target.exports;
  tasks.spawnLocalTask("fixture", [], {});
  let reported;
  child.once("error", (error) => {
    reported = error;
  });
  assert.equal(tasks.cancelLocalTask(child), true);
  child.exitCode = 143;
  assert.doesNotThrow(() => child.emit("exit", 143));
  assert.equal(reported, denied, "retain the OS error for the task's existing error handler");
  assert.deepEqual(signals, [
    [-child.pid, "SIGTERM"],
    [-child.pid, "SIGKILL"],
  ]);
});
