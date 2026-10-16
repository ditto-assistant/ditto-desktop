const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { projectFolder, defaultWorkspace, resolveWorkspace } = require("../src/workspace.cjs");

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

test("first launch creates a private reusable Ditto workspace without a selected project", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-home-test-"));
  try {
    const folder = resolveWorkspace(data, null);
    assert.equal(folder, fs.realpathSync(path.join(data, "workspaces", "default")));
    assert.notEqual(folder, fs.realpathSync(os.homedir()));
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
    fs.writeFileSync(path.join(folder, "keep.txt"), "existing task output");
    assert.equal(defaultWorkspace(data), folder);
    assert.equal(fs.readFileSync(path.join(folder, "keep.txt"), "utf8"), "existing task output");
    assert.equal(resolveWorkspace(data, path.join(data, "missing")), folder);
    assert.equal(resolveWorkspace(data, os.homedir()), folder);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("an explicitly selected project remains selected instead of being replaced by Ditto's home", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-selected-test-"));
  try {
    const project = path.join(data, "project");
    fs.mkdirSync(project);
    assert.equal(resolveWorkspace(data, project), fs.realpathSync(project));
    assert.equal(fs.existsSync(path.join(data, "workspaces", "default")), false);
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
  }
});
