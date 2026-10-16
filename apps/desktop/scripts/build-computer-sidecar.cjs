const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const version = "0.8.12";
const archiveName = `cmux-cua-${version}-darwin-universal-unsigned-binary.tar.gz`;
const sha256 = "ec293fce3fec05622d167da058588c745c17a461506ec1c48352a7d6ad59f954";
const cache = path.join(root, ".build", "computer-use");
const archive = path.join(cache, archiveName);
const app = path.join(root, "native", "bin", "Ditto Computer Use.app");
async function build() {
  if (process.platform !== "darwin") return;
  fs.mkdirSync(cache, { recursive: true });
  if (!fs.existsSync(archive)) {
    const response = await fetch(
      `https://github.com/manaflow-ai/cmux-cua/releases/download/cmux-cua-v${version}/${archiveName}`,
    );
    if (!response.ok) throw new Error(`Computer Use download failed (${response.status}).`);
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex") !== sha256)
    throw new Error("Computer Use archive checksum mismatch; remove the cached archive and retry.");
  const contents = path.join(app, "Contents");
  fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
  const unpack = fs.mkdtempSync(path.join(cache, "unpack-"));
  try {
    execFileSync("tar", ["-xzf", archive, "-C", unpack, "cmux-cua"]);
    // The upstream cmux-branded name activates host-specific identity checks.
    // This independently launched helper owns Ditto's bundle and TCC identity.
    fs.copyFileSync(
      path.join(unpack, "cmux-cua"),
      path.join(contents, "MacOS", "DittoComputerUse"),
    );
  } finally {
    fs.rmSync(unpack, { recursive: true, force: true });
  }
  fs.chmodSync(path.join(contents, "MacOS", "DittoComputerUse"), 0o755);
  fs.copyFileSync(
    path.join(root, "resources", "icon.png"),
    path.join(contents, "Resources", "Ditto.png"),
  );
  const icons = fs.mkdtempSync(path.join(cache, "icons-"));
  const iconset = path.join(icons, "Ditto.iconset");
  fs.mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        execFileSync(
          "/usr/bin/sips",
          [
            "-z",
            String(size * scale),
            String(size * scale),
            path.join(root, "resources", "icon.png"),
            "--out",
            path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
          ],
          { stdio: "ignore" },
        );
      }
    }
    execFileSync("/usr/bin/iconutil", [
      "-c",
      "icns",
      iconset,
      "-o",
      path.join(contents, "Resources", "Ditto.icns"),
    ]);
  } finally {
    fs.rmSync(icons, { recursive: true, force: true });
  }
  fs.copyFileSync(
    path.join(root, "native", "computer-use", "ENGINE-LICENSE"),
    path.join(contents, "Resources", "ENGINE-LICENSE"),
  );
  fs.writeFileSync(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.heyditto.computer-use</string>
<key>CFBundleExecutable</key><string>DittoComputerUse</string>
<key>CFBundleName</key><string>Ditto Computer Use</string>
<key>CFBundleDisplayName</key><string>Ditto Computer Use</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleIconFile</key><string>Ditto.icns</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSAccessibilityUsageDescription</key><string>Control apps when you ask a Ditto agent to use your Mac.</string>
<key>NSScreenCaptureUsageDescription</key><string>Let Ditto agents see the app you ask them to use.</string>
</dict></plist>`,
  );
  execFileSync("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "ai.heyditto.computer-use",
    app,
  ]);
  execFileSync(
    "/usr/bin/swiftc",
    [
      "-O",
      path.join(root, "native", "computer-use", "launch.swift"),
      "-o",
      path.join(root, "native", "bin", "ditto-computer-launcher"),
    ],
    { stdio: "inherit" },
  );
  console.log(`Built Ditto Computer Use ${version} (verified SHA-256) at ${app}`);
}
build().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
