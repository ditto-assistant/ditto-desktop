import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const desktopRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = NodePath.resolve(desktopRoot, "../..");
const sourceDirectory = NodePath.join(repoRoot, "native", "telegram-sidecar");
const archArgumentIndex = process.argv.indexOf("--arch");
const outputArgumentIndex = process.argv.indexOf("--output");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone native build script.
const arch = archArgumentIndex >= 0 ? process.argv[archArgumentIndex + 1] : process.arch;
const output =
  outputArgumentIndex >= 0
    ? NodePath.resolve(process.argv[outputArgumentIndex + 1])
    : NodePath.join(desktopRoot, ".native", "ditto-telegram-sidecar");

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone native build script.
if (NodeOS.platform() !== "darwin") process.exit(0);
if (arch !== "arm64" && arch !== "x64" && arch !== "universal") {
  throw new Error(`Unsupported Telegram sidecar architecture: ${String(arch)}`);
}

function build(targetArch, destination) {
  const apiID = process.env.DITTO_TELEGRAM_API_ID?.trim() ?? "";
  const apiHash = process.env.DITTO_TELEGRAM_API_HASH?.trim() ?? "";
  const ldflags = ["-s", "-w"];
  if (apiID !== "") ldflags.push(`-X main.buildAPIID=${apiID}`);
  if (apiHash !== "") ldflags.push(`-X main.buildAPIHash=${apiHash}`);
  const result = NodeChildProcess.spawnSync(
    "go",
    [
      "build",
      "-mod=readonly",
      "-trimpath",
      `-ldflags=${ldflags.join(" ")}`,
      "-o",
      destination,
      ".",
    ],
    {
      cwd: sourceDirectory,
      encoding: "utf8",
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: "darwin",
        GOARCH: targetArch,
        GOTOOLCHAIN: "local",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || `go build exited ${String(result.status)}`);
}

NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
if (arch === "universal") {
  const temporaryDirectory = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), "ditto-telegram-sidecar-"),
  );
  try {
    const arm64 = NodePath.join(temporaryDirectory, "arm64");
    const x64 = NodePath.join(temporaryDirectory, "x64");
    build("arm64", arm64);
    build("amd64", x64);
    const lipo = NodeChildProcess.spawnSync("lipo", ["-create", arm64, x64, "-output", output], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (lipo.status !== 0) throw new Error(lipo.stderr || `lipo exited ${String(lipo.status)}`);
  } finally {
    NodeFS.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
} else {
  build(arch === "x64" ? "amd64" : "arm64", output);
}
NodeFS.chmodSync(output, 0o755);
