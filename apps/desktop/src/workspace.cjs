const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

function defaultWorkspace(dataDir) {
  const folder = path.join(dataDir, "workspaces", "default");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const resolved = projectFolder(folder);
  if (!resolved) throw new Error("Ditto's workspace is unavailable.");
  return resolved;
}

function resolveWorkspace(dataDir, selected) {
  return projectFolder(selected) || defaultWorkspace(dataDir);
}

module.exports = { projectFolder, defaultWorkspace, resolveWorkspace };
