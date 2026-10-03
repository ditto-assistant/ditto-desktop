const test = require('node:test');
const assert = require('node:assert/strict');
const { LocalChannels } = require('../src/channels.cjs');

test('unconfigured Telegram never attempts restoration or login', async () => {
  const channels = new LocalChannels('/unused', '/unused');
  const calls = [];
  channels.clients.telegram.request = async method => {
    calls.push(method);
    if (method !== 'status') throw new Error('An unconfigured client must not launch login');
    return { configured: false, connected: false };
  };
  assert.equal((await channels.status('telegram')).restoring, undefined);
  await assert.rejects(channels.startLogin('telegram'), /credentials/);
  assert.deepEqual(calls, ['status', 'status']);
});

test('concurrent Discord status checks share one restore operation', async () => {
  const channels = new LocalChannels('/unused', '/unused');
  const calls = [];
  channels.clients.discord.request = async method => {
    calls.push(method);
    await new Promise(resolve => setImmediate(resolve));
    return { connected: method === 'connection.restore' };
  };
  const states = await Promise.all([channels.status('discord'), channels.status('discord')]);
  assert.ok(states.every(s => s.connected));
  assert.deepEqual(calls, ['status', 'connection.restore']);
});

test('disconnect clears cached conversations so the next account cannot see them', async () => {
  const channels = new LocalChannels('/unused', '/unused');
  channels.cache.set('discord', { at: Date.now(), value: [{ id: 'old-account' }] });
  channels.clients.discord.request = async () => ({ connected: false });
  await channels.logout('discord');
  assert.equal(channels.cache.has('discord'), false);
});
