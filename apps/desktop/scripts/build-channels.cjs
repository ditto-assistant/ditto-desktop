const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (os.platform() !== "darwin") throw new Error("Local channel sidecars currently require macOS.");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "native", "bin");
fs.mkdirSync(output, { recursive: true });

function googleSecret(name) {
  const result = spawnSync(
    "gcloud",
    ["secrets", "versions", "access", "latest", "--project=ditto-app-dev", `--secret=${name}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return result.status === 0 ? result.stdout.trim() : "";
}

const telegramId =
  process.env.DITTO_TELEGRAM_API_ID?.trim() || googleSecret("PROD_TELEGRAM_API_ID");
const telegramHash =
  process.env.DITTO_TELEGRAM_API_HASH?.trim() || googleSecret("PROD_TELEGRAM_API_HASH");
for (const [source, binary] of [
  ["discord-sidecar", "ditto-discord-sidecar"],
  ["telegram-sidecar", "ditto-telegram-sidecar"],
]) {
  const flags = ["-s", "-w"];
  if (source === "telegram-sidecar" && telegramId && telegramHash) {
    if (!/^\d+$/.test(telegramId) || !/^[a-f0-9]{32}$/i.test(telegramHash))
      throw new Error("Invalid Telegram API configuration.");
    flags.push(`-X main.buildAPIID=${telegramId}`, `-X main.buildAPIHash=${telegramHash}`);
  }
  const result = spawnSync(
    "go",
    [
      "build",
      "-mod=readonly",
      "-trimpath",
      `-ldflags=${flags.join(" ")}`,
      "-o",
      path.join(output, binary),
      ".",
    ],
    {
      cwd: path.join(root, "native", "local-channels", source),
      stdio: "inherit",
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: "darwin",
        GOARCH: os.arch() === "x64" ? "amd64" : "arm64",
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${source} build failed with exit ${result.status}`);
  fs.chmodSync(path.join(output, binary), 0o755);
  console.log(
    `${binary} built${source === "telegram-sidecar" && !telegramId ? " without Telegram API configuration" : ""}.`,
  );
}
// pnpm retains Grok's launcher; npm extracts a sibling binary. Bundle the
// versioned vendor binary directly so releases work with either package manager.
const grokRoot = path.dirname(require.resolve("@xai-official/grok/package.json"));
const vendorRoot = path.dirname(
  require.resolve(`@xai-official/grok-darwin-${os.arch()}/package.json`, { paths: [grokRoot] }),
);
const binary = path.join(vendorRoot, "bin", "grok");
const compressed = `${binary}.br`;
const data = fs.existsSync(binary)
  ? fs.readFileSync(binary)
  : require("node:zlib").brotliDecompressSync(fs.readFileSync(compressed));
fs.writeFileSync(path.join(output, "grok"), data, { mode: 0o755 });
fs.chmodSync(path.join(output, "grok"), 0o755);
console.log("Official Grok Build CLI bundled.");

require("./build-google-messages.cjs");
