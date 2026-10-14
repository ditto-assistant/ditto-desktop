const http = require("node:http");
const crypto = require("node:crypto");

async function startAgentBrowser(browser, onOpen = () => {}, computer = null) {
  const token = crypto.randomBytes(32).toString("hex");
  const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (
      request.method !== "POST" ||
      request.url !== "/action" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.writeHead(403).end(JSON.stringify({ error: "Unavailable" }));
      return;
    }
    try {
      request.setEncoding("utf8");
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 20000) throw new Error("Browser action is too large.");
      }
      const input = JSON.parse(body);
      let result;
      switch (input.action) {
        case "navigate":
          result = await browser.navigate(input.url);
          onOpen();
          break;
        case "snapshot":
          result = await browser.snapshot();
          break;
        case "click":
          result = await browser.click(input.ref);
          break;
        case "fill":
          result = await browser.fill(input.ref, input.text);
          break;
        case "back":
          result = browser.back();
          break;
        case "forward":
          result = browser.forward();
          break;
        case "reload":
          result = browser.reload();
          break;
        case "computer_status":
          result = await computer?.("status");
          break;
        case "computer_snapshot":
          result = await computer?.("snapshot");
          break;
        case "computer_activate":
          result = await computer?.("activate", input.ref);
          break;
        case "computer_click":
          result = await computer?.("click", input.ref);
          break;
        case "computer_set":
          result = await computer?.("set", input.ref, input.text);
          break;
        default:
          throw new Error("Unsupported browser action.");
      }
      if (result === undefined)
        throw new Error("Mac computer control is unavailable in this task.");
      response.writeHead(200).end(JSON.stringify(result));
    } catch (error) {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    token,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startAgentBrowser };
