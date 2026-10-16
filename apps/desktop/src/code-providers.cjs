const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnLocalTask, wasLocalTaskCancelled } = require("./local-task.cjs");

const names = { codex: "Codex", claude: "Claude Code", cursor: "Cursor Agent", grok: "Grok" };
const MAX_RESPONSE_CHARS = 200000;
function binaryFor(provider) {
  const home = os.homedir();
  const bundledGrok = process.resourcesPath
    ? path.join(process.resourcesPath, "channel-sidecars", "grok")
    : path.join(__dirname, "..", "native", "bin", "grok");
  const candidates = {
    codex: [
      path.join(home, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    ],
    claude: [
      path.join(home, ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ],
    cursor: [
      path.join(home, ".local", "bin", "cursor-agent"),
      "/opt/homebrew/bin/cursor-agent",
      "/usr/local/bin/cursor-agent",
    ],
    grok: [
      bundledGrok,
      path.join(__dirname, "..", "native", "bin", "grok"),
      path.join(home, ".local", "bin", "grok"),
      "/opt/homebrew/bin/grok",
      "/usr/local/bin/grok",
    ],
  }[provider];
  if (!candidates) throw new Error("Unsupported coding provider.");
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function providerAvailability() {
  return Object.entries(names).map(([id, name]) => ({
    id,
    name,
    available: Boolean(binaryFor(id)),
    detail: binaryFor(id) ? "Installed on this Mac" : `${name} CLI is not installed on this Mac.`,
  }));
}

function startProvider(provider, prompt, workspace, onText, options = {}) {
  const binary = binaryFor(provider);
  if (!binary) throw new Error(`${names[provider]} CLI is not installed on this Mac.`);
  const worker = path.join(
    __dirname,
    "..",
    "native",
    "provider-runtime",
    "desktop-provider-worker.mjs",
  );
  if (!fs.existsSync(worker))
    throw new Error("Coding runtime is missing. Rebuild Ditto Desktop before running this engine.");
  const child = spawnLocalTask(process.execPath, [worker], {
    onCancel: () => send({ type: "cancel" }),
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PATH: [
        path.join(os.homedir(), ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        process.env.PATH || "",
      ].join(":"),
    },
  });
  let answer = "";
  let response;
  let resumeCursor = options.resumeCursor;
  let failure;
  let diagnostic = "";
  const send = (message) => {
    if (!child.connected || (wasLocalTaskCancelled(child) && message.type !== "cancel")) return;
    child.send(message, (error) => {
      if (error && !wasLocalTaskCancelled(child)) failure = error.message;
    });
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-5000);
  });
  // SDK diagnostics belong on stderr, never in the assistant transcript.
  child.stdout.resume();
  child.on("message", (message) => {
    if (message.type === "event") {
      const event = message.event;
      options.onEvent?.(event, message.live === true);
      if (message.tool) options.onTool?.(message.tool);
      if (
        message.live &&
        event.type === "content.delta" &&
        event.payload.streamKind === "assistant_text"
      ) {
        const text = event.payload.delta.slice(0, Math.max(0, MAX_RESPONSE_CHARS - answer.length));
        answer += text;
        if (text) onText(text);
      }
    } else if (message.type === "session") {
      resumeCursor = message.resumeCursor;
      options.onResumeCursor?.(resumeCursor);
    } else if (message.type === "approval") {
      // A missing or failed presentation handler must never silently approve.
      Promise.resolve()
        .then(() => options.approve?.(message.event) ?? "decline")
        .then(
          (decision) => send({ type: "approval", requestId: message.event.requestId, decision }),
          () => send({ type: "approval", requestId: message.event.requestId, decision: "decline" }),
        );
    } else if (message.type === "result") response = message.result;
    else if (message.type === "error") failure = message.message;
  });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (wasLocalTaskCancelled(child))
        resolve({
          text: answer.trim(),
          cancelled: true,
          resumeCursor: response?.resumeCursor || resumeCursor,
        });
      else if (code === 0 && response && !failure) resolve({ ...response, text: answer.trim() });
      else
        reject(
          new Error(
            failure ||
              diagnostic.trim() ||
              `${names[provider]} runtime exited before completing the task.`,
          ),
        );
    });
  });
  send({
    type: "start",
    provider,
    binaryPath: binary,
    prompt,
    stateDir: options.stateDir || path.join(os.tmpdir(), "ditto-provider-runtime"),
    session: {
      threadId: options.sessionId || require("node:crypto").randomUUID(),
      cwd: workspace,
      runtimeMode: "auto-accept-edits",
      ...(options.resumeCursor ? { resumeCursor: options.resumeCursor } : {}),
    },
  });
  return { child, result };
}

module.exports = { binaryFor, providerAvailability, startProvider };
