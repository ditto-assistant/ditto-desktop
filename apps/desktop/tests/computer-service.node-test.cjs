const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { ComputerService } = require("../src/computer-service.cjs");

async function fixture(t, permissions = true) {
  const requests = [];
  const connections = new Set();
  let config;
  let server;
  const terminated = [];
  const service = new ComputerService({
    terminate: (pid) => {
      terminated.push(pid);
      for (const socket of connections) socket.destroy();
    },
    launch: async (input) => {
      config = input;
      server = net.createServer((socket) => {
        connections.add(socket);
        socket.on("close", () => connections.delete(socket));
        socket.setEncoding("utf8");
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk;
          if (!buffer.includes("\n")) return;
          const envelope = JSON.parse(buffer.split("\n")[0]);
          assert.equal(envelope.auth_token, input.environment.CMUX_CUA_SOCKET_AUTH_TOKEN);
          const request = envelope.request;
          requests.push(request);
          let result = {};
          if (request.method === "list")
            result = {
              profile: "native",
              tools: ["click", "get_window_state", "press_key", "set_config", "kill_app"].map(
                (name) => ({
                  name,
                  input_schema: { type: "object", properties: {} },
                  description: name,
                }),
              ),
            };
          if (request.method === "permissions_status") {
            assert.equal(
              envelope.host_auth_token,
              input.environment.CMUX_CUA_SOCKET_HOST_AUTH_TOKEN,
            );
            result = { accessibility: permissions, screen_recording: permissions };
          }
          if (request.method === "call")
            result = {
              content: [{ type: "image", mimeType: "image/png", data: "fixture-image" }],
              structuredContent: { windows: [{ pid: 42, window_id: 791, title: "Calculator" }] },
              isError: false,
            };
          if (request.method === "call" && request.name === "click")
            result = {
              content: [{ type: "text", text: "Stale element: inspect the window again." }],
              isError: true,
            };
          if (request.method === "call" && request.name === "press_key")
            result = {
              content: [{ type: "text", text: "Key sent; inspect the display to verify." }],
              structuredContent: { effect: "unverifiable" },
            };
          socket.write(JSON.stringify({ ok: true, result }) + "\n");
        });
      });
      server.listen(input.arguments[input.arguments.indexOf("--socket") + 1]);
      await once(server, "listening");
      return 12345;
    },
  });
  t.after(async () => {
    await service.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
  return { service, requests, terminated, config: () => config };
}

test("setup runs independently with private authentication and cannot enable missing permissions", async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(f.service.createSession(), /Enable Computer Use/);
  assert.equal(f.config(), undefined);
  await f.service.prepare();
  assert.equal(f.config().environment.CMUX_CUA_EXTERNAL_PERMISSION_FLOW, "1");
  assert.notEqual(
    f.config().environment.CMUX_CUA_SOCKET_HOST_AUTH_TOKEN,
    f.config().environment.CMUX_CUA_SOCKET_AUTH_TOKEN,
  );
  await assert.rejects(f.service.enable(), /Allow Accessibility and Screen Recording/);
  assert.equal(f.service.enabled, false);
  assert.equal(
    f.requests.some((request) => request.method === "call"),
    false,
  );
});

test("MCP retains images, binds actions to a session, and revokes queued access on Stop", async (t) => {
  const f = await fixture(t);
  await f.service.enable();
  const session = await f.service.mcpSession();
  const rpc = (method, params, token = session.token) =>
    fetch(session.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  assert.equal((await rpc("tools/list", {}, "wrong")).status, 403);
  const catalog = await (await rpc("tools/list")).json();
  assert.deepEqual(
    catalog.result.tools.map((tool) => tool.name),
    ["computer_click", "computer_get_window_state", "computer_press_key"],
  );
  const result = await (
    await rpc("tools/call", {
      name: "computer_get_window_state",
      arguments: { session: "spoofed" },
    })
  ).json();
  assert.deepEqual(result.result.content, [
    { type: "image", mimeType: "image/png", data: "fixture-image" },
  ]);
  const call = f.requests.find((request) => request.method === "call");
  assert.equal(call.session_id, session.id);
  assert.equal(call.args.session, session.id);
  await assert.rejects(session.call("computer_set_config", {}), /Unsupported/);
  const first = session.call("computer_click", {});
  const queued = session.call("computer_click", {});
  // Both calls are queued in microtasks. Stop invalidates them synchronously.
  const stopped = f.service.stop();
  await assert.rejects(first, /session has ended/);
  await assert.rejects(queued, /session has ended/);
  await stopped;
  assert.deepEqual(f.terminated, [12345]);
  assert.equal(f.service.sessions.size, 0);
  assert.equal(f.requests.filter((request) => request.method === "call").length, 1);
});

test("unverified input cannot be retried with another delivery mode until its target is inspected", async (t) => {
  const f = await fixture(t);
  await f.service.enable();
  const session = await f.service.createSession();
  const args = { pid: 42, window_id: 791, key: "1" };
  await session.call("computer_press_key", { ...args, delivery_mode: "background" });
  await assert.rejects(
    session.call("computer_press_key", {
      delivery_mode: "foreground",
      key: "1",
      window_id: 791,
      pid: 42,
    }),
    /Inspect this app/,
  );
  assert.equal(f.requests.filter((request) => request.name === "press_key").length, 1);
  await session.call("computer_get_window_state", { pid: 42, window_id: 999 });
  await assert.rejects(session.call("computer_press_key", args), /Inspect this app/);
  await session.call("computer_get_window_state", { pid: 42, window_id: 791 });
  await session.call("computer_press_key", { ...args, delivery_mode: "foreground" });
  assert.equal(f.requests.filter((request) => request.name === "press_key").length, 2);
});

test("the actual Ditto Code extension consumes the authenticated MCP catalog and image results", async (t) => {
  const f = await fixture(t);
  await f.service.enable();
  const session = await f.service.mcpSession();
  const previous = {
    url: process.env.DITTO_COMPUTER_MCP_URL,
    token: process.env.DITTO_COMPUTER_MCP_TOKEN,
  };
  process.env.DITTO_COMPUTER_MCP_URL = session.url;
  process.env.DITTO_COMPUTER_MCP_TOKEN = session.token;
  t.after(() => {
    session.close();
    for (const [key, value] of [
      ["DITTO_COMPUTER_MCP_URL", previous.url],
      ["DITTO_COMPUTER_MCP_TOKEN", previous.token],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { default: extension } = await import("../src/pi-computer-extension.mjs");
  const tools = [];
  await extension({ registerTool: (tool) => tools.push(tool) });
  const inspect = tools.find((tool) => tool.name === "computer_get_window_state");
  assert.ok(inspect);
  const result = await inspect.execute("fixture-call", {});
  assert.equal(result.content[0].type, "image");
  assert.equal(result.content[0].data, "fixture-image");
  const grounding = result.content.find((part) => part.type === "text");
  assert.deepEqual(JSON.parse(grounding.text), {
    windows: [{ pid: 42, window_id: 791, title: "Calculator" }],
  });
  await assert.rejects(
    tools.find((tool) => tool.name === "computer_click").execute("stale-click", {}),
    /Stale element: inspect the window again/,
  );
});
