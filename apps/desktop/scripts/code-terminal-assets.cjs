const fs = require("node:fs");
const path = require("node:path");

function copyCodeTerminalAssets(output) {
  const target = path.join(output, "terminal");
  fs.mkdirSync(target, { recursive: true });
  const xterm = require.resolve("@xterm/xterm");
  const fit = require.resolve("@xterm/addon-fit");
  for (const [source, name] of [
    [xterm, "xterm.js"],
    [path.join(path.dirname(xterm), "../css/xterm.css"), "xterm.css"],
    [path.join(path.dirname(xterm), "../LICENSE"), "xterm.LICENSE"],
    [fit, "addon-fit.js"],
    [path.join(path.dirname(fit), "../LICENSE"), "addon-fit.LICENSE"],
  ])
    fs.copyFileSync(source, path.join(target, name));
}

module.exports = { copyCodeTerminalAssets };
