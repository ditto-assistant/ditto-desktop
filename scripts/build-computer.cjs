const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'darwin') process.exit(0);
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'native', 'computer-use', 'main.swift');
const output = path.join(root, 'native', 'bin', 'ditto-computer-use');
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync('/usr/bin/swiftc', ['-O', source, '-o', output], { stdio: 'inherit' });
console.log(`Ditto computer helper built at ${output}`);
