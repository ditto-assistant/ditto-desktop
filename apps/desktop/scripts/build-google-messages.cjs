const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const source = path.join(root, ".build", "google-messages-bridge");
const revision = "fa68130c0da0511140382c24d986e270c6461ce3";
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      CGO_ENABLED: "0",
      GOOS: "darwin",
      GOARCH: os.arch() === "x64" ? "amd64" : "arm64",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Google Messages component build failed.");
}
fs.mkdirSync(path.dirname(source), { recursive: true });
if (!fs.existsSync(path.join(source, ".git")))
  run("git", ["clone", "https://github.com/ditto-assistant/google-messages-bridge.git", source]);
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" });
if (head.stdout.trim() !== revision) {
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: source, encoding: "utf8" });
  if (dirty.stdout.trim())
    throw new Error("Preserve local Google Messages component edits before rebuilding.");
  run("git", ["fetch", "origin", revision], source);
  run("git", ["checkout", "--detach", revision], source);
}
const bin = path.join(root, "native", "bin");
fs.mkdirSync(bin, { recursive: true });
run(
  "go",
  [
    "build",
    "-mod=readonly",
    "-trimpath",
    "-o",
    path.join(bin, "ditto-google-messages-bridge"),
    ".",
  ],
  source,
);
// The AGPL transport stays a separate process with its own source and notices.
const notices = path.join(bin, "google-messages-source");
fs.mkdirSync(notices, { recursive: true });
for (const file of ["LICENSE", "NOTICE", "README.md"])
  fs.copyFileSync(path.join(source, file), path.join(notices, file));
fs.writeFileSync(
  path.join(notices, "SOURCE.txt"),
  `Source: https://github.com/ditto-assistant/google-messages-bridge/tree/${revision}\nBuild: go build -mod=readonly -trimpath .\nGoogle Messages protocol remains a separate AGPL process.\n`,
);
run(
  "git",
  ["archive", "--format=tar.gz", `--output=${path.join(notices, "source.tar.gz")}`, revision],
  source,
);
require(path.join(root, "web", "ditto-app", "node_modules", "esbuild")).buildSync({
  entryPoints: [path.join(root, "src", "googlemessages", "GoogleMessagesSignIn.ts")],
  outfile: path.join(root, "native", "google-messages-sign-in.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
