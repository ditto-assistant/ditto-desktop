const test = require('node:test');
const assert = require('node:assert/strict');
const { startAgentBrowser } = require('../src/browser-agent.cjs');

test('Pi browser bridge accepts only the task token and dispatches supported actions', async () => {
  const calls = [];
  const browser = {
    navigate: async url => { calls.push(url); return { url }; },
    snapshot: async () => ({ text: 'Test page', controls: [] }),
  };
  const bridge = await startAgentBrowser(browser);
  try {
    const endpoint = `http://127.0.0.1:${bridge.port}/action`;
    const denied = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ action: 'navigate', url: 'https://example.com' }) });
    assert.equal(denied.status, 403);
    assert.equal(calls.length, 0);
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ action: 'navigate', url: 'https://example.com' }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: 'https://example.com' });
    assert.deepEqual(calls, ['https://example.com']);
  } finally { await bridge.close(); }
});

test('Mac actions require a task-scoped computer handler', async () => {
  const bridge = await startAgentBrowser({});
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/action`, {
      method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` },
      body: JSON.stringify({ action: 'computer_snapshot' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /unavailable/);
  } finally { await bridge.close(); }
});
