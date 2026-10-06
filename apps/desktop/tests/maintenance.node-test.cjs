const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { updatePlan, EngineMaintenance } = require("../src/maintenance.cjs");

test("updates the actual npm owner and leaves vendor bundles and unknown installs alone", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ditto-engine-")));
  try {
    const pkg = path.join(root, "lib/node_modules/@anthropic-ai/claude-code");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-code" }),
    );
    const binary = path.join(pkg, "bin/claude");
    fs.writeFileSync(binary, "");
    fs.writeFileSync(path.join(root, "bin/npm"), "");
    const plan = updatePlan("claude", binary);
    assert.equal(plan.supported, true);
    assert.equal(plan.executable, path.join(root, "bin/npm"));
    assert.deepEqual(plan.args, [
      "install",
      "-g",
      "--prefix",
      root,
      "--allow-scripts=@anthropic-ai/claude-code",
      "@anthropic-ai/claude-code@latest",
    ]);
    const vendor = path.join(root, "ChatGPT.app/Contents/MacOS/codex");
    fs.mkdirSync(path.dirname(vendor), { recursive: true });
    fs.writeFileSync(vendor, "");
    assert.equal(updatePlan("codex", vendor).supported, false);
    const unknown = path.join(root, "codex");
    fs.writeFileSync(unknown, "");
    assert.equal(updatePlan("codex", unknown).supported, false);
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "wrong-package" }));
    assert.equal(updatePlan("claude", binary).supported, false);
    assert.throws(() => updatePlan("bash", "/bin/bash"), /Unsupported/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses engine updates while coding or another update is active", async () => {
  let launched = false;
  const maintenance = new EngineMaintenance({
    busy: () => true,
    run: async () => {
      launched = true;
    },
  });
  await assert.rejects(maintenance.update("claude"), /Wait for active/);
  assert.equal(launched, false);
  maintenance.busy = () => false;
  maintenance.active = "cursor";
  await assert.rejects(maintenance.update("claude"), /Wait for active/);
  assert.equal(launched, false);
});
