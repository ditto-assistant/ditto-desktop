import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const desktopRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone native build script has no Effect runtime.
if (process.platform !== "darwin") process.exit(0);

const archArgumentIndex = process.argv.indexOf("--arch");
const outputArgumentIndex = process.argv.indexOf("--output");
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone native build script has no Effect runtime.
const arch = archArgumentIndex >= 0 ? process.argv[archArgumentIndex + 1] : process.arch;
const output =
  outputArgumentIndex >= 0
    ? NodePath.resolve(process.argv[outputArgumentIndex + 1])
    : NodePath.join(desktopRoot, ".native", "ditto-discord-ax");
if (arch !== "arm64" && arch !== "x64") {
  throw new Error(`Unsupported macOS helper architecture: ${String(arch)}`);
}

NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
const target = `${arch === "x64" ? "x86_64" : "arm64"}-apple-macos13.0`;
const source = NodePath.join(desktopRoot, "native", "discord-accessibility", "main.swift");
const result = NodeChildProcess.spawnSync(
  "xcrun",
  [
    "swiftc",
    "-O",
    "-target",
    target,
    "-framework",
    "AppKit",
    "-framework",
    "ApplicationServices",
    source,
    "-o",
    output,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);
if (result.status !== 0) {
  throw new Error(result.stderr || `swiftc exited ${String(result.status)}`);
}
NodeFS.chmodSync(output, 0o755);
