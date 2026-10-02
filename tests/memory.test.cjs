const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { MemoryStore, parseTrajectoryLine, redact } = require('../src/memory.cjs');

test('extracts user and assistant text without collecting system or tool content', () => {
  const codex = JSON.stringify({ type: 'response_item', timestamp: '2026-10-02T00:00:00Z', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the desktop memory scan' }],
  } });
  const cursor = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'I fixed the scan.' }] } });
  assert.equal(parseTrajectoryLine('codex', codex).text, 'Fix the desktop memory scan');
  assert.equal(parseTrajectoryLine('cursor', cursor).text, 'I fixed the scan.');
  assert.equal(parseTrajectoryLine('codex', codex.replace('"user"', '"system"')), null);
  assert.equal(parseTrajectoryLine('cursor', JSON.stringify({ role: 'tool', message: { content: 'secret' } })), null);
});

test('redacts credentials before local persistence', () => {
  assert.equal(redact('token ditto_mcp_abcdefghijklmnopqrstuvwxyz'), 'token [credential removed]');
  assert.equal(redact('api_key=abcdefghijklmnopq'), 'api_key=[credential removed]');
});

test('indexes Git code and both trajectory formats, then exports a cloud-ready file', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ditto-local-test-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project');
  const codexRoot = path.join(root, 'codex');
  const cursorRoot = path.join(root, 'cursor');
  await fsp.mkdir(repo); await fsp.mkdir(codexRoot); await fsp.mkdir(path.join(cursorRoot, 'agent-transcripts'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  await fsp.writeFile(path.join(repo, 'README.md'), '# Memory Garden\nThis project remembers flowers.\n');
  await fsp.writeFile(path.join(repo, '.env'), 'API_KEY=do-not-index');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  await fsp.writeFile(path.join(codexRoot, 'session.jsonl'), [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Plant roses' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Roses planted' }] } },
  ].map(JSON.stringify).join('\n'));
  await fsp.writeFile(path.join(cursorRoot, 'agent-transcripts', 'session.jsonl'), [
    { role: 'user', message: { content: 'Make the garden blue' } },
    { role: 'assistant', message: { content: 'The garden is blue' } },
  ].map(JSON.stringify).join('\n'));
  const store = new MemoryStore(path.join(root, 'data'));
  t.after(() => store.close());
  const options = { roots: [root], trajectoryRoots: [['codex', codexRoot], ['cursor', cursorRoot]] };
  const first = await store.scan(options);
  assert.equal(first.repos, 1);
  assert.equal(first.code, 1);
  assert.equal(first.codex, 2);
  assert.equal(first.cursor, 2);
  assert.equal(store.search('roses').length, 2);
  assert.equal(store.search('do-not-index').length, 0);
  const nativePath = path.join(__dirname, '..', 'native', 'ditto-harness.node');
  if (fs.existsSync(nativePath)) {
    const { Harness } = require(nativePath);
    const harness = await Harness.open(path.join(root, 'ditto-harness.sqlite'), { embedder: 'hash' });
    assert.equal(await store.syncHarness(harness), 2);
    assert.equal(await store.syncHarness(harness), 0);
    assert.ok((await harness.searchMemories('local', 'roses', { minSimilarity: 0, limit: 8 })).length > 0);
  }
  const second = await store.scan(options);
  assert.equal(second.code + second.codex + second.cursor, 0);
  const destination = await store.exportCloudBundle();
  const lines = (await fsp.readFile(destination, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 5);
  assert.equal(JSON.parse(lines[0]).format, 'ditto-local-memory-v1');
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
});
