export default async function (pi) {
  const url = process.env.DITTO_COMPUTER_MCP_URL;
  const token = process.env.DITTO_COMPUTER_MCP_TOKEN;
  if (!url || !token) return;
  let nextId = 0;
  const rpc = async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error("Computer Use was stopped or disconnected.");
    const result = await response.json();
    if (result.error) throw new Error(result.error.message);
    return result.result;
  };
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "ditto-code", version: "1.0.0" },
    capabilities: {},
  });
  const { tools } = await rpc("tools/list");
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name.replace(/^computer_/, "").replaceAll("_", " "),
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_id, args) {
        const result = await rpc("tools/call", { name: tool.name, arguments: args });
        const content = [...result.content];
        // Native discovery returns IDs/bounds in structuredContent; its text
        // may only say "Found 1 window". Pi consumes content blocks, so give
        // the model the grounding data as well as the human-readable summary.
        if (result.structuredContent !== undefined)
          content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
        // Preserve screenshots as images; never turn image bytes into prompt text.
        if (result.isError) {
          const message = content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          throw new Error(message || "Computer Use could not complete this action.");
        }
        return { content, details: {} };
      },
    });
  }
}
