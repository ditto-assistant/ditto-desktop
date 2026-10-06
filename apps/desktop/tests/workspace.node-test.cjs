const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { projectFolder } = require("../src/workspace.cjs");

test("resolves project folders but rejects the home folder and its symlinks", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-workspace-"));
  try {
    const project = path.join(temporary, "project");
    const linkedHome = path.join(temporary, "home-link");
    fs.mkdirSync(project);
    fs.symlinkSync(os.homedir(), linkedHome);
    assert.equal(projectFolder(project), fs.realpathSync(project));
    assert.equal(projectFolder(os.homedir()), null);
    assert.equal(projectFolder(linkedHome), null);
    assert.equal(projectFolder(path.join(temporary, "missing")), null);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
