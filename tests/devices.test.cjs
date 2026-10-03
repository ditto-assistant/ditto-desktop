const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');
const { DesktopDevices, RPC_PATH } = require('../src/devices.cjs');

const encode = request => Buffer.from(JSON.stringify(request)).toString('base64');

test('paired device requests cross the host bridge; unknown peers and arbitrary commands are rejected', async () => {
  const server = new WebSocket.WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const hostId = randomUUID(); const peerId = randomUUID(); let savedId;
  let updateCalls = 0; let peer;
  const desktop = new DesktopDevices({ apiBase: `http://127.0.0.1:${server.address().port}`, getKey: () => 'test-key',
    version: 'test', saveHostId: id => { savedId = id; }, maintenance: {
      status: async () => ({ engines: [{ id: 'claude', version: '2.test' }] }),
      update: async provider => { updateCalls++; return { id: provider, version: 'new' }; },
    } });
  const connected = new Promise(resolve => server.once('connection', (socket, request) => {
    peer = socket; assert.equal(request.headers.authorization, 'Bearer test-key');
    socket.once('message', bytes => {
      const hello = JSON.parse(bytes.toString()); assert.equal(hello.kind, 'desktop'); assert.deepEqual(hello.capabilities.harnesses, []);
      socket.send(JSON.stringify({ type: 'welcome', hostId, pairedHostIds: [peerId], heartbeatSeconds: 30 })); resolve();
    });
  }));
  const read = async action => { const next = once(peer, 'message'); action(); return JSON.parse((await next)[0].toString()); };
  try {
    desktop.start(); await connected;
    // Synchronize on a real response, which proves welcome was processed.
    let response = await read(() => peer.send(JSON.stringify({ type: 'ping' })));
    assert.equal(response.type, 'pong'); assert.equal(savedId, hostId); assert.equal(desktop.status().online, true);
    response = await read(() => peer.send(JSON.stringify({ type: 'env.open', tunnelId: randomUUID(), peerHostId: randomUUID(), path: RPC_PATH })));
    assert.equal(response.type, 'env.close');
    response = await read(() => peer.send(JSON.stringify({ type: 'env.open', tunnelId: randomUUID(), peerHostId: peerId, path: '/ws' })));
    assert.equal(response.type, 'env.close');
    const tunnelId = randomUUID();
    peer.send(JSON.stringify({ type: 'env.open', tunnelId, peerHostId: peerId, path: RPC_PATH }));
    const request = { version: 1, id: randomUUID(), method: 'engines.update', params: { provider: 'claude' } };
    response = await read(() => peer.send(JSON.stringify({ type: 'env.frame', tunnelId, payload: encode(request) })));
    assert.equal(JSON.parse(Buffer.from(response.payload, 'base64')).result.version, 'new');
    response = await read(() => peer.send(JSON.stringify({ type: 'env.frame', tunnelId, payload: encode(request) })));
    assert.equal(JSON.parse(Buffer.from(response.payload, 'base64')).result.id, 'claude'); assert.equal(updateCalls, 1);
    response = await read(() => peer.send(JSON.stringify({ type: 'env.frame', tunnelId, payload: encode({ ...request, method: 'shell.exec', params: { command: 'rm -rf' } }) })));
    assert.equal(response.type, 'env.close'); assert.equal(updateCalls, 1);
    const revokeId = randomUUID(); peer.send(JSON.stringify({ type: 'env.open', tunnelId: revokeId, peerHostId: peerId, path: RPC_PATH }));
    response = await read(() => peer.send(JSON.stringify({ type: 'hosts.paired', hostIds: [] })));
    assert.equal(response.tunnelId, revokeId); assert.equal(response.type, 'env.close');
    await assert.rejects(desktop.request(peerId, 'engines.status'), /Pair this device/);
  } finally { desktop.stop(); peer?.terminate(); await new Promise(resolve => server.close(resolve)); }
});

test('outgoing paired RPC uses the authenticated backend environment proxy', async () => {
  const server = new WebSocket.WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const hostId = randomUUID(); const peerId = randomUUID();
  const desktop = new DesktopDevices({ apiBase: `http://127.0.0.1:${server.address().port}`, getKey: () => 'test-key', version: 'test' });
  desktop.hostId = hostId; desktop.paired.add(peerId); desktop.state.online = true;
  server.on('connection', (socket, request) => {
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.pathname, `/api/v5/hosts/${peerId}/env`); assert.equal(url.searchParams.get('fromHostId'), hostId);
    assert.equal(url.searchParams.get('path'), RPC_PATH); assert.equal(request.headers.authorization, 'Bearer test-key');
    socket.on('message', bytes => { const frame = JSON.parse(bytes.toString()); socket.send(JSON.stringify({ version: 1, id: frame.id, result: { version: 'test' } })); });
  });
  try { assert.deepEqual(await desktop.request(peerId, 'desktop.status'), { version: 'test' }); }
  finally { desktop.stop(); for (const client of server.clients) client.terminate(); await new Promise(resolve => server.close(resolve)); }
});
