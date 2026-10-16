const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

for (const restart of [false, true])
  test(
    `a broken Discord component input pipe is recoverable (restart=${restart})`,
    { timeout: 10000 },
    async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-channel-pipe-"));
      fs.writeFileSync(
        path.join(root, "ditto-discord-sidecar"),
        `#!/usr/bin/env python3
import json, os, signal, sys, threading
marker = os.path.join(sys.argv[2], "first-started")
if not os.path.exists(marker):
    open(marker, "w").close()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.close(0)
    print(json.dumps({"event":"connection.qa-input-closed"}), flush=True)
    # A failed host cannot leave a fixture process behind indefinitely.
    threading.Timer(5, lambda: os._exit(0)).start()
    signal.pause()
else:
    pending = None
    for line in sys.stdin:
        request = json.loads(line)
        if request["method"] == "status":
            pending = request["id"]
            print(json.dumps({"event":"connection.qa-status-waiting"}), flush=True)
        elif request["method"] == "qa.release":
            print(json.dumps({"id":pending,"result":{"connected":False,"detail":"Fixture component ready"}}), flush=True)
            print(json.dumps({"id":request["id"],"result":{}}), flush=True)
`,
        { mode: 0o700 },
      );
      const worker = spawn(
        process.execPath,
        [
          "-e",
          `
const assert = require("node:assert/strict");
const {once} = require("node:events");
const {LocalChannels} = require(process.argv[2]);
const {resolve:inputClosed,promise:inputReady} = Promise.withResolvers();
const {resolve:statusWaiting,promise:statusReady} = Promise.withResolvers();
const channels = new LocalChannels(process.argv[1],process.argv[1], event => {
  if (event.event === "connection.qa-input-closed") inputClosed();
  if (event.event === "connection.qa-status-waiting") statusWaiting();
});
(async () => {
  const client = channels.clients.discord;
  const old = client.ensureStarted();
  process.send({type:"spawned",pid:old.pid});
  old.stderr.on("data", data => console.error(String(data)));
  try {
    await inputReady;
    await assert.rejects(client.request("status"), /EPIPE|pipe|closed/i);
    if (${restart}) {
      const current = client.request("status").then(value => ({value}), error => ({error}));
      process.send({type:"spawned",pid:client.child.pid});
      await statusReady;
      const exited = once(old,"exit");
      old.kill("SIGKILL");
      await exited;
      await client.request("qa.release");
      const receipt = await current;
      assert.equal(receipt.error,undefined);
      assert.equal(receipt.value.connected,false);
    }
    console.log("PIPE_FAILURE_RECOVERED");
  } finally {
    const children = new Set([old,client.child].filter(Boolean));
    const closed = [...children].map(async child => {
      if (child.exitCode === null && child.signalCode === null) await once(child,"close");
      process.send({type:"reaped",pid:child.pid});
    });
    channels.close();
    old.kill("SIGKILL");
    await Promise.all(closed);
  }
})().catch(error => { console.error(error); process.exitCode=1; });
`,
          root,
          path.resolve(__dirname, "../src/channels.cjs"),
        ],
        {
          env: {
            ...process.env,
            HOME: root,
            ELECTRON_RUN_AS_NODE: "1",
            PATH: `/opt/homebrew/opt/node/bin:${process.env.PATH}`,
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      const owned = new Set();
      worker.on("message", ({ type, pid }) => {
        if (type === "spawned") owned.add(pid);
        if (type === "reaped") owned.delete(pid);
      });
      let output = "",
        errors = "";
      worker.stdout.on("data", (data) => {
        output += data;
      });
      worker.stderr.on("data", (data) => {
        errors += data;
      });
      t.after(async () => {
        if (worker.exitCode === null && worker.signalCode === null) {
          const closed = once(worker, "close");
          worker.kill("SIGKILL");
          await closed;
        }
        // Only PIDs captured at this fixture's spawn, never name-matched processes.
        for (const pid of owned) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        fs.rmSync(root, { recursive: true, force: true });
      });
      const [code] = await once(worker, "close");
      assert.equal(code, 0, errors);
      assert.match(output, /PIPE_FAILURE_RECOVERED/, errors);
    },
  );
