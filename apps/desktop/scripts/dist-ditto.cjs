const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const target = process.argv.includes("--target=dmg") ? "dmg" : "dir";
const stage = path.join(root, ".build", "release");
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

if (os.platform() !== "darwin")
  throw new Error("This Ditto Desktop release currently targets macOS.");
if (!process.argv.includes("--skip-build")) {
  for (const name of ["web", "channels", "computer", "native"]) {
    run(process.execPath, [path.join(__dirname, `build-${name}.cjs`)]);
  }
}
for (const file of [
  "resources/web/index.html",
  "native/ditto-harness.node",
  "native/bin/ditto-discord-sidecar",
  "native/bin/ditto-google-messages-bridge",
  "native/google-messages-sign-in.cjs",
  "native/bin/ditto-telegram-sidecar",
  "native/bin/Ditto Computer Use.app/Contents/MacOS/DittoComputerUse",
  "native/bin/ditto-computer-launcher",
  "native/bin/grok",
]) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing build resource: ${file}`);
}
fs.mkdirSync(stage, { recursive: true });
for (const folder of ["src", "native", "resources"]) {
  const destination = path.join(stage, folder);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(path.join(root, folder), destination, { recursive: true });
}
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.ditto.json"), "utf8"));
const desktop = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
fs.copyFileSync(path.join(root, "..", "..", "LICENSE"), path.join(stage, "LICENSE"));
const manifest = {
  name: "@heyditto/desktop",
  version: desktop.version,
  private: true,
  author: desktop.author,
  description: desktop.description,
  main: "src/main.cjs",
  dependencies: lock.packages[""].dependencies,
  devDependencies: lock.packages[""].devDependencies,
};
lock.name = manifest.name;
lock.version = manifest.version;
Object.assign(lock.packages[""], { name: manifest.name, version: manifest.version });
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(stage, "package-lock.json"), JSON.stringify(lock, null, 2));
fs.copyFileSync(
  path.join(root, "electron-builder.ditto.yml"),
  path.join(stage, "electron-builder.yml"),
);
run("npm", ["ci", "--no-audit", "--no-fund"], stage);
// Use the runtime's supported app-name setting for model setup. Keep its
// credential directory unchanged so existing model sign-ins survive updates.
const runtimeManifestPath = path.join(
  stage,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json",
);
const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, "utf8"));
runtimeManifest.piConfig = { ...runtimeManifest.piConfig, name: "ditto" };
fs.writeFileSync(runtimeManifestPath, JSON.stringify(runtimeManifest, null, 2));
run(
  process.execPath,
  [
    path.join(stage, "node_modules/electron-builder/cli.js"),
    "--mac",
    target,
    "--arm64",
    "--config",
    "electron-builder.yml",
    "--config.directories.output=../../dist-ditto",
  ],
  stage,
);
