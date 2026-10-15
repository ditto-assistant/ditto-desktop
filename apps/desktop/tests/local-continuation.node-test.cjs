const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { MemoryStore } = require("../src/memory.cjs");
const { localTaskContext } = require("../src/task-context.cjs");
const { spawnSandboxedPi } = require("../src/pi-sandbox.cjs");
const { cancelLocalTask } = require("../src/local-task.cjs");

const cli = path.join(
  __dirname,
  "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
);

test(
  "an interrupted saved runtime resumes without replaying old requests as the new user turn",
  {
    skip: os.platform() !== "darwin" || !fs.existsSync(cli),
    timeout: 30000,
  },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-continuation-"));
    const agentDir = path.join(root, "agent");
    const sessionFile = path.join(agentDir, "sessions", "qa.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    const store = new MemoryStore(path.join(root, "data"));
    const requests = [];
    let signalReady;
    const ready = new Promise((resolve) => {
      signalReady = resolve;
    });
    const server = http.createServer(async (request, response) => {
      if (request.url === "/ready") {
        response.end("ready");
        signalReady();
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      requests.push(JSON.parse(raw));
      const tool = requests.length === 2;
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: "wait-tool",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: `/usr/bin/curl -fsS http://127.0.0.1:${server.address().port}/ready; sleep 90`,
                  }),
                },
              },
            ],
          }
        : { content: requests.length === 1 ? "READY" : "RECOVERED" };
      const chunk = (value, reason = null) => ({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "qa",
        choices: [{ index: 0, delta: value, finish_reason: reason }],
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify(chunk(delta))}\n\ndata: ${JSON.stringify(chunk({}, tool ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            api: "openai-completions",
            apiKey: "fixture",
            models: [{ id: "qa" }],
          },
        },
      }),
    );
    const children = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close");
          cancelLocalTask(child);
          await closed;
        }
      }
      server.close();
      server.closeAllConnections();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const start = (question) => {
      const context = localTaskContext({
        question,
        turns: store.piSessionTurns("qa"),
        resumed: fs.existsSync(sessionFile),
      });
      const run = store.startPiRun(root, question, "pi", "qa");
      const child = spawnSandboxedPi(
        process.execPath,
        cli,
        [
          "--mode",
          "json",
          "--print",
          "--offline",
          "--provider",
          "ollama",
          "--model",
          "qa",
          "--session",
          sessionFile,
          "--no-context-files",
          "--no-skills",
          "--no-themes",
          "--no-extensions",
          "--approve",
          "--append-system-prompt",
          context.systemNote || "Synthetic desktop QA.",
          "--",
          context.prompt,
        ],
        { workspace: root, agentDir, dataDir: root },
      );
      children.push(child);
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const closed = once(child, "close").then(([code]) => ({ code, stderr }));
      return { child, closed, run };
    };
    const first = start("Remember synthetic word LANTERN. Reply READY.");
    assert.equal((await first.closed).code, 0);
    store.finishPiRun(first.run, "done", "READY");
    const waiting = start("Use bash to wait; reply WAIT_FINISHED only after it completes.");
    await ready;
    assert.equal(cancelLocalTask(waiting.child), true);
    assert.equal((await waiting.closed).code, 143);
    store.finishPiRun(waiting.run, "cancelled", "");
    const followup = start("Reply exactly RECOVERED. Do not continue the stopped task.");
    const result = await followup.closed;
    assert.equal(result.code, 0, result.stderr);
    const body = requests[2];
    const users = body.messages.filter((message) => message.role === "user");
    assert.equal(users.length, 3, JSON.stringify(body.messages));
    assert.deepEqual(users.at(-1).content, [
      { type: "text", text: "Reply exactly RECOVERED. Do not continue the stopped task." },
    ]);
    assert.equal(JSON.stringify(users).split("WAIT_FINISHED").length - 1, 1);
    assert.ok(
      body.messages.some(
        (message) =>
          message.role === "system" && message.content.includes("previous turn was stopped"),
      ),
    );
    assert.ok(
      body.messages.some(
        (message) => message.role === "tool" && message.tool_call_id === "wait-tool",
      ),
    );
    store.finishPiRun(followup.run, "done", "RECOVERED");
    const next = start("What was the synthetic word?");
    assert.equal((await next.closed).code, 0);
    assert.ok(JSON.stringify(requests[3].messages).includes("LANTERN"));
    assert.equal(requests[3].messages.filter((message) => message.role === "user").length, 4);
    assert.ok(
      !requests[3].messages.some(
        (message) =>
          message.role === "system" && message.content.includes("previous turn was stopped"),
      ),
    );
  },
);

test("missing runtime history is recovered with completion status and without cross-conversation turns", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-history-"));
  const store = new MemoryStore(root);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const other = store.startPiRun(root, "UNRELATED_PRIVATE_FIXTURE", "pi", "other");
  store.finishPiRun(other, "done", "OTHER_RESPONSE");
  for (let index = 0; index < 7; index++) {
    const run = store.startPiRun(root, `request ${index}`, "pi", "qa");
    store.finishPiRun(
      run,
      index === 6 ? "cancelled" : "done",
      index === 6 ? "partial" : "complete",
    );
  }
  const context = localTaskContext({
    question: "Current task",
    turns: store.piSessionTurns("qa"),
    resumed: false,
  });
  assert.ok(context.prompt.endsWith("Current task"));
  assert.ok(context.prompt.includes('"status":"cancelled"'));
  assert.ok(context.prompt.includes('"assistant":"partial"'));
  assert.ok(!context.prompt.includes("UNRELATED_PRIVATE_FIXTURE"));
  assert.ok(!context.prompt.includes("request 0"));
  assert.ok(context.systemNote.includes("stopped by the user"));
});
