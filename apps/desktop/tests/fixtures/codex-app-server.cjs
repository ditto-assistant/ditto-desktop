const fs = require("node:fs");
const readline = require("node:readline");

const threadId = "fixture-native-thread";
const thread = {
  id: threadId,
  sessionId: "fixture-session",
  cliVersion: "0.1.0",
  createdAt: 1,
  updatedAt: 1,
  cwd: process.cwd(),
  ephemeral: false,
  modelProvider: "openai",
  preview: "",
  source: "cli",
  status: { type: "idle" },
  turns: [],
};
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const response = (id, result) => write({ id, result });
const notify = (method, params) => write({ method, params });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, `${line}\n`);
  if (request.id === undefined) return;
  switch (request.method) {
    case "initialize":
      response(request.id, {
        userAgent: "fixture",
        codexHome: process.cwd(),
        platformFamily: "unix",
        platformOs: "fixture",
      });
      break;
    case "thread/start":
    case "thread/resume":
      response(request.id, {
        thread,
        cwd: process.cwd(),
        model: "gpt-fixture",
        modelProvider: "openai",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [process.cwd()],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      });
      break;
    case "turn/start": {
      const turn = { id: "fixture-turn", items: [], status: "inProgress", error: null };
      response(request.id, { turn });
      setImmediate(() => {
        notify("turn/started", { threadId, turn });
        notify("item/agentMessage/delta", {
          threadId,
          turnId: turn.id,
          itemId: "answer",
          delta: "Ditto ✓ café",
        });
        notify("turn/completed", { threadId, turn: { ...turn, status: "completed" } });
      });
      break;
    }
    default:
      response(request.id, {});
  }
});
input.on("close", () => process.exit(0));
