const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnLocalTask, wasLocalTaskCancelled } = require("./local-task.cjs");
const readline = require("node:readline");

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

function startProvider(provider, prompt, workspace, onText) {
  const binary = binaryFor(provider);
  if (!binary) throw new Error(`${names[provider]} CLI is not installed on this Mac.`);
  let args;
  let stdinPrompt = prompt;
  let grokPromptDir = null;
  if (provider === "codex")
    args = ["exec", "--json", "--approve-for-me", "--skip-git-repo-check", "-C", workspace, "-"];
  else if (provider === "claude")
    args = ["-p", "--output-format", "text", "--permission-mode", "acceptEdits"];
  else if (provider === "cursor") {
    args = ["-p", "--output-format", "text", "--workspace", workspace, prompt];
    stdinPrompt = "";
  } else if (provider === "grok") {
    grokPromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-grok-"));
    const promptFile = path.join(grokPromptDir, "task.txt");
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    args = [
      "--no-auto-update",
      "--prompt-file",
      promptFile,
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "plain",
      "--cwd",
      workspace,
    ];
    stdinPrompt = "";
  }
  const child = spawnLocalTask(binary, args, {
    // Codex uses its interactive interrupt path to abort detached tool groups.
    cancelSignal: provider === "codex" ? "SIGINT" : "SIGTERM",
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: [
        path.join(os.homedir(), ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        process.env.PATH || "",
      ].join(":"),
    },
  });
  // Pipe chunks need not end on a UTF-8 character boundary.
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  if (grokPromptDir)
    child.once("close", () => {
      fs.rmSync(grokPromptDir, { recursive: true, force: true });
    });
  let inputError;
  // A CLI can exit (for example, on expired authentication) before reading its prompt.
  // Keep the stream error local and report failure after stdout/stderr have drained.
  child.stdin.on("error", (error) => {
    inputError = error;
  });
  child.stdin.end(stdinPrompt);
  let answer = "";
  let stderr = "";
  const appendAnswer = (text) => {
    if (!text || answer.length >= MAX_RESPONSE_CHARS) return;
    const available = MAX_RESPONSE_CHARS - answer.length;
    const part = text.slice(0, available);
    answer += part;
    onText(part);
  };
  if (provider === "codex") {
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          event.item.text
        ) {
          appendAnswer(`${answer ? "\n\n" : ""}${event.item.text}`);
        }
      } catch {
        /* Ignore non-protocol lines. */
      }
    });
  } else
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, "");
      appendAnswer(text);
    });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-5000);
  });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (wasLocalTaskCancelled(child)) resolve({ text: answer.trim(), cancelled: true });
      else if (code === 0 && !inputError) resolve({ text: answer.trim() });
      else
        reject(
          new Error(
            stderr.trim() ||
              (inputError
                ? `Could not send the task to ${names[provider]}. Check that it is signed in and try again.`
                : answer.trim().slice(-1000) || `${names[provider]} exited with code ${code}.`),
          ),
        );
    });
  });
  return { child, result };
}

module.exports = { binaryFor, providerAvailability, startProvider };
