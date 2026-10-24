const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const { WebSocketServer } = require("ws");
const { ComputerRelay } = require("../src/computer-relay.cjs");

test("cloud relay binds tools to turns and closes capabilities on disconnect", async (t) => {
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const calls = [];
  let closed = 0;
  const relay = new ComputerRelay({
    apiBase: `http://127.0.0.1:${server.address().port}`,
    service: {
      enabled: true,
      createSession: async () => ({
        tools: [{ name: "computer_click" }],
        call: async (name, args) => {
          calls.push({ name, args });
          return { content: [{ type: "text", text: "fixture clicked" }] };
        },
        close: () => {
          closed++;
        },
      }),
    },
  });
  t.after(async () => {
    relay.stop();
    ws.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const connecting = relay.link("fixture-bearer-credential");
  const [host, request] = await once(ws, "connection");
  assert.equal(request.headers.authorization, "Bearer fixture-bearer-credential");
  assert.equal(request.url, "/api/v5/desktop/computer/ws");
  host.send(JSON.stringify({ type: "ready", leaseID: randomUUID() }));
  await connecting;
  const send = async (method, turnID, params) => {
    const response = once(host, "message");
    host.send(
      JSON.stringify({
        id: randomUUID(),
        method,
        turnID,
        params,
        deadline: Math.floor(Date.now() / 1000) + 60,
      }),
    );
    return JSON.parse((await response)[0]);
  };
  const turn = randomUUID();
  const tools = await send("open", turn);
  assert.equal(tools.result.tools[0].name, "computer_click");
  assert.ok((await send("call", randomUUID(), { name: "computer_click" })).error);
  assert.equal(calls.length, 0);
  await send("call", turn, { name: "computer_click", arguments: { window_id: 42 } });
  assert.deepEqual(calls, [{ name: "computer_click", args: { window_id: 42 } }]);
  await send("close", turn);
  assert.equal(closed, 1);
  await send("open", randomUUID());
  const disconnected = once(host, "close");
  relay.stop();
  await disconnected;
  assert.equal(closed, 2);
  assert.equal(relay.status().connected, false);
  assert.equal(relay.sessions.size, 0);
});
