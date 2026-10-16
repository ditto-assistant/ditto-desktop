const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startAgentBrowser } = require("../src/browser-agent.cjs");

test("Pi browser bridge accepts only the task token and dispatches supported actions", async () => {
  const calls = [];
  const browser = {
    navigate: async (url) => {
      calls.push(url);
      return { url };
    },
    snapshot: async () => ({ text: "Test page", controls: [] }),
  };
  const bridge = await startAgentBrowser(browser);
  try {
    const endpoint = `http://127.0.0.1:${bridge.port}/action`;
    const denied = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ action: "navigate", url: "https://example.com" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(calls.length, 0);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ action: "navigate", url: "https://example.com" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: "https://example.com" });
    assert.deepEqual(calls, ["https://example.com"]);
  } finally {
    await bridge.close();
  }
});

test("Mac actions require a task-scoped computer handler", async () => {
  const bridge = await startAgentBrowser({});
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/action`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ action: "computer_snapshot" }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /unavailable/);
  } finally {
    await bridge.close();
  }
});

test("browser and Mac field text survives UTF-8 splits in the actual HTTP bridge", async () => {
  const calls = [];
  const bridge = await startAgentBrowser(
    {
      fill: async (ref, text) => {
        calls.push(["browser", ref, text]);
        return { filled: true };
      },
    },
    () => {},
    async (action, ref, text) => {
      calls.push([action, ref, text]);
      return { set: true };
    },
  );
  try {
    for (const [action, ref] of [
      ["fill", "d1"],
      ["computer_set", "w0.1"],
    ]) {
      const body = Buffer.from(JSON.stringify({ action, ref, text: "café ✓ 🦜" }));
      const result = await new Promise((resolve, reject) => {
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port: bridge.port,
            path: "/action",
            method: "POST",
            headers: { Authorization: `Bearer ${bridge.token}` },
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (part) => {
              text += part;
            });
            response.on("end", () =>
              resolve({ status: response.statusCode, body: JSON.parse(text) }),
            );
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        // Chunked HTTP bodies can split even a single UTF-8 character.
        for (const byte of body) request.write(Buffer.from([byte]));
        request.end();
      });
      assert.equal(result.status, 200);
    }
    assert.deepEqual(calls, [
      ["browser", "d1", "café ✓ 🦜"],
      ["set", "w0.1", "café ✓ 🦜"],
    ]);
  } finally {
    await bridge.close();
  }
});

test(
  "closing a task disconnects a pending browser request without reopening the browser",
  { timeout: 5000 },
  async (t) => {
    const entered = Promise.withResolvers();
    const navigation = Promise.withResolvers();
    t.after(() => navigation.resolve({ url: "https://example.com" }));
    let opened = 0;
    const bridge = await startAgentBrowser(
      {
        navigate: async () => {
          entered.resolve();
          return navigation.promise;
        },
      },
      () => {
        opened++;
      },
    );
    const result = fetch(`http://127.0.0.1:${bridge.port}/action`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ action: "navigate", url: "https://example.com" }),
    }).then(
      async (response) => ({ status: response.status, body: await response.json() }),
      () => ({ disconnected: true }),
    );
    try {
      await entered.promise;
      const closing = bridge.close();
      // Closing must finish while navigation is still blocked.
      await closing;
      const receipt = await result;
      navigation.resolve({ url: "https://example.com" });
      // Drain the resumed HTTP handler before checking its late UI callback.
      await new Promise(setImmediate);
      assert.equal(opened, 0, "a completed task must not reopen the browser panel");
      assert.deepEqual(receipt, { disconnected: true });
      await assert.rejects(fetch(`http://127.0.0.1:${bridge.port}/action`));
    } finally {
      navigation.resolve({ url: "https://example.com" });
      await result;
      await bridge.close();
    }
  },
);
