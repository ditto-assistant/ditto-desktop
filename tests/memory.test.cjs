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

test('ranks memory content above a distractor path match', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ditto-memory-rank-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = new MemoryStore(root);
  t.after(() => store.close());
  store.addDoc('code', '/fake/ditto-local-desktop.ts', 0, '', 'ditto-local-desktop.ts',
    'This file only defines a generic button.', '2026-10-02T00:00:00Z');
  store.addDoc('code', '/real/README.md', 0, '', 'README.md',
    'The local Ditto desktop remembers code, Codex trajectories, and Cursor conversations in private memory.',
    '2026-10-02T00:00:00Z');
  const result = store.search('What does the local Ditto desktop remember?', 2);
  assert.equal(result[0].path, '/real/README.md');
});

test('indexes Git code and both trajectory formats, then exports Ditto import ZIPs', async t => {
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
  const dittoImport = await store.exportDittoImport();
  assert.equal(dittoImport.records, 5);
  assert.equal(dittoImport.files.length, 1);
  const entries = execFileSync('unzip', ['-Z', '-1', dittoImport.files[0]], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(entries.length, 5);
  assert.ok(entries.every(entry => /^notes\/(code|codex|cursor)\/[a-f0-9]{64}\.md$/.test(entry)));
  assert.equal(fs.statSync(dittoImport.files[0]).mode & 0o777, 0o600);
});

test('Pi conversations retain their engine and workspace separately from other executions', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ditto-session-test-'));
  const store = new MemoryStore(root);
  try {
    const id = store.startPiRun('/tmp/pi-project', 'Pi turn', 'pi', 'local-session');
    store.finishPiRun(id, 'done', 'Pi answer');
    const other = store.startPiRun('/tmp/other-project', 'Codex turn', 'codex');
    store.finishPiRun(other, 'done', 'Codex answer');
    assert.equal(store.piSession('local-session').workspace, '/tmp/pi-project');
    assert.equal(store.piSession('local-session').provider, 'pi');
    assert.equal(store.piSession('unknown-session'), undefined);
    assert.equal(store.recentPiRuns()[0].session_id, null);
  } finally { store.close(); await fsp.rm(root, { recursive: true, force: true }); }
});
