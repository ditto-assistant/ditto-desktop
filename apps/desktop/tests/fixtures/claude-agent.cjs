const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(
  process.env.T3_ACP_REQUEST_LOG_PATH,
  `${JSON.stringify({ argv: process.argv.slice(2) })}\n`,
);
const sessionId = "11111111-2222-4333-8444-555555555555";
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.T3_ACP_REQUEST_LOG_PATH, `${line}\n`);
  if (message.type === "control_request") {
    write({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { commands: [], models: [], account: {} },
      },
    });
  }
  if (message.type !== "user") return;
  write({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-fixture",
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    apiKeySource: "none",
    permissionMode: "acceptEdits",
  });
  const usage = {
    input_tokens: 1,
    output_tokens: 3,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  write({
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: "answer",
    message: {
      id: "answer",
      type: "message",
      role: "assistant",
      model: "claude-fixture",
      content: [{ type: "text", text: "Ditto ✓ café" }],
      usage,
      stop_reason: "end_turn",
      stop_sequence: null,
    },
  });
  write({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    uuid: "result",
    is_error: false,
    result: "Ditto ✓ café",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    usage,
    total_cost_usd: 0,
    modelUsage: {},
    permission_denials: [],
  });
});
input.on("close", () => process.exit(0));
