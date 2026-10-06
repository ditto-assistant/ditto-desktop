const fs = require("node:fs");
const os = require("node:os");

function projectFolder(folder) {
  if (typeof folder !== "string" || !folder.trim()) return null;
  try {
    const resolved = fs.realpathSync(folder);
    if (resolved === fs.realpathSync(os.homedir())) return null;
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

module.exports = { projectFolder };
