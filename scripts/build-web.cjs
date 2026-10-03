const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const web = path.join(root, 'web', 'ditto-app');
const output = path.join(root, 'resources', 'web');
const envFile = path.join(root, '.env.desktop.local');
const productionEnv = path.join(web, '.env.production.local');
const appSource = path.join(web, 'src', 'App.tsx');
const codeComposerSource = path.join(web, 'src', 'components', 'code', 'codeComposer.ts');
const codeModeSource = path.join(web, 'src', 'components', 'code', 'codeModeState.ts');
const { codeComposerOverlay, codeModeOverlay } = require('./desktop-code-bridge.cjs');

if (!fs.existsSync(path.join(web, 'package.json'))) {
  throw new Error('Ditto web source is missing. Run git submodule update --init --recursive.');
}
if (!fs.existsSync(envFile)) {
  throw new Error('Missing .env.desktop.local. Copy .env.desktop.example and set the Ditto Firebase and API values.');
}

const env = fs.readFileSync(envFile, 'utf8');
for (const key of ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_DITTO_API_BASE']) {
  if (!new RegExp(`^${key}=.+$`, 'm').test(env)) throw new Error(`${key} is required in .env.desktop.local`);
}
const originals = new Map([appSource, codeComposerSource, codeModeSource].map(file => [file, fs.readFileSync(file, 'utf8')]));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: web, stdio: 'inherit', env: { ...process.env, VITE_DITTO_DESKTOP: 'true' } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`);
}

try {
  fs.writeFileSync(productionEnv, `${env.trim()}\nVITE_DITTO_DESKTOP=true\n`, { mode: 0o600 });
  const app = originals.get(appSource).replace('if (typeof window !== "undefined") {',
    'if (typeof window !== "undefined" && !import.meta.env.VITE_DITTO_DESKTOP) {');
  if (app === originals.get(appSource)) throw new Error('Ditto update hook changed upstream.');
  fs.writeFileSync(appSource, app);
  fs.writeFileSync(codeComposerSource, codeComposerOverlay(originals.get(codeComposerSource)));
  fs.writeFileSync(codeModeSource, codeModeOverlay(originals.get(codeModeSource)));
  if (!fs.existsSync(path.join(web, 'node_modules'))) run('bun', ['install', '--frozen-lockfile']);
  run('bun', ['run', 'build']);
  fs.rmSync(output, { recursive: true, force: true });
  fs.cpSync(path.join(web, 'build'), output, { recursive: true });
  fs.copyFileSync(path.join(root, 'src', 'desktop-shell.css'), path.join(output, 'desktop-shell.css'));
  fs.copyFileSync(path.join(root, 'src', 'desktop-shell.js'), path.join(output, 'desktop-shell.js'));
  const index = path.join(output, 'index.html');
  let html = fs.readFileSync(index, 'utf8');
  html = html.replace('</head>', '<link rel="stylesheet" href="/desktop-shell.css"></head>')
    .replace('</body>', '<script defer src="/desktop-shell.js"></script></body>')
    .replace(/<title>[^<]*<\/title>/, '<title>Ditto Desktop</title>');
  fs.writeFileSync(index, html);
  console.log(`Built Ditto Desktop renderer from ${web}`);
} finally {
  for (const [file, content] of originals) fs.writeFileSync(file, content);
  fs.rmSync(productionEnv, { force: true });
}
