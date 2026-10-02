const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandboxProfile } = require('../src/pi-sandbox.cjs');

test('Pi can write in its project but cannot write to another local folder',
  { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ditto-pi-boundary-'));
    const workspace = path.join(root, 'project');
    const agentDir = path.join(root, 'agent');
    const tempDir = path.join(root, 'temp');
    const outside = path.join(root, 'outside');
    for (const folder of [workspace, agentDir, tempDir, outside]) fs.mkdirSync(folder);
    try {
      const result = spawnSync('/usr/bin/sandbox-exec', [
        '-p', sandboxProfile(workspace, agentDir, tempDir), '/bin/sh', '-c',
        'printf allowed > "$PROJECT_DIR/inside"; printf denied > "$OUTSIDE_DIR/escaped"',
      ], { encoding: 'utf8', env: { ...process.env, PROJECT_DIR: workspace, OUTSIDE_DIR: outside } });
      assert.notEqual(result.status, 0);
      assert.equal(fs.readFileSync(path.join(workspace, 'inside'), 'utf8'), 'allowed');
      assert.equal(fs.existsSync(path.join(outside, 'escaped')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
