const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const cli = path.join(
  __dirname,
  "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
);

test(
  "Pi waits for an actual read result before generating a dependent local write",
  {
    skip: !fs.existsSync(cli),
    timeout: 30000,
  },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-pi-order-"));
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(root, "input.txt"), "Actual file contents\n");
    const requests = [];
    let prematureWrite = false;
    const server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      let calls = [];
      let content;
      if (requests.length === 1) {
        calls = [
          { id: "read-input", name: "read", arguments: { path: "input.txt" } },
          {
            id: "guessed-write",
            name: "write",
            arguments: { path: "output.txt", content: "PLACEHOLDER" },
          },
        ];
      } else if (requests.length === 2) {
        prematureWrite = fs.existsSync(path.join(root, "output.txt"));
        const read = body.messages.find(
          (message) => message.role === "tool" && message.tool_call_id === "read-input",
        );
        calls = [
          {
            id: "actual-write",
            name: "write",
            arguments: { path: "output.txt", content: read?.content || "MISSING READ" },
          },
        ];
      } else content = "Copied the observed file contents.";
      const delta = calls.length
        ? {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
        : { content };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => ({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "qa",
        choices: [{ index: 0, delta, finish_reason }],
      });
      response.end(
        `data: ${JSON.stringify(chunk(delta))}\n\ndata: ${JSON.stringify(chunk({}, calls.length ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
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
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          cli,
          "--mode",
          "json",
          "--print",
          "--offline",
          "--provider",
          "ollama",
          "--model",
          "qa",
          "--no-session",
          "--no-context-files",
          "--no-skills",
          "--no-themes",
          "--no-extensions",
          "--extension",
          path.join(__dirname, "../src/pi-local-tools.mjs"),
          "--approve",
          "--",
          "Copy input.txt to output.txt using tools.",
        ],
        {
          cwd: root,
          env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stdout.resume();
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const [code] = await once(child, "close");
      assert.equal(code, 0, stderr);
      assert.equal(
        prematureWrite,
        false,
        "The guessed write must not run before the model observes the read",
      );
      assert.equal(requests.length, 3);
      assert.equal(requests[1].messages.filter((message) => message.role === "tool").length, 1);
      assert.equal(
        fs.readFileSync(path.join(root, "output.txt"), "utf8"),
        fs.readFileSync(path.join(root, "input.txt"), "utf8"),
      );
    } finally {
      if (child && child.exitCode === null) child.kill();
      server.close();
      server.closeAllConnections();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
