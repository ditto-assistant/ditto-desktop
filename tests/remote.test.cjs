const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cliAvailable, runCli, RemoteHost } = require('../src/remote.cjs');

test('bundled Ditto Teleport previews a local repo without uploading it', async () => {
  assert.equal(cliAvailable(), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-teleport-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    fs.writeFileSync(path.join(root, 'README.md'), 'Local test project');
    const plan = JSON.parse(await runCli(['teleport', 'plan', root, '--json'], {
      key: 'test-key-unused-for-plan', cwd: root, timeoutMs: 30000,
    }));
    assert.equal(plan.root, fs.realpathSync(root));
    assert.equal(plan.repos.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Remote Control rejects unsupported engines before launching a process', () => {
  const host = new RemoteHost(() => {});
  assert.throws(() => host.start('pi', { key: 'test', cwd: os.tmpdir() }), /Choose Codex/);
  assert.equal(host.status().running, false);
});
