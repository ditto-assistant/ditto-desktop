const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.join(root, ".build", "ditto-harness");
const target = path.join(root, "native", "ditto-harness.node");
const revision = "b2c647b";

if (!fs.existsSync(path.join(source, ".git"))) {
  fs.mkdirSync(path.dirname(source), { recursive: true });
  execFileSync("git", ["clone", "https://github.com/ditto-assistant/ditto-harness.git", source], {
    stdio: "inherit",
  });
}
execFileSync("git", ["checkout", revision], { cwd: source, stdio: "inherit" });
const nodeDir = path.join(source, "crates", "node");
execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: nodeDir, stdio: "inherit" });
execFileSync("npm", ["run", "build"], { cwd: nodeDir, stdio: "inherit" });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(
  path.join(nodeDir, `ditto-harness-node.${os.platform()}-${os.arch()}.node`),
  target,
);
console.log(`Ditto memory harness ready at ${target}`);
