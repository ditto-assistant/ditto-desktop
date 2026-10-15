const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const web = path.join(root, "web", "ditto-app");
test(
  "local Code uses the shared Markdown renderer and disposes replaced replies",
  { skip: !fs.existsSync(path.join(web, "node_modules", "vitest")), timeout: 60000 },
  () => {
    const fixture = fs.mkdtempSync(path.join(web, "src", "desktop-code-test-"));
    try {
      for (const file of ["local-code.tsx", "local-code.test.tsx"])
        fs.copyFileSync(path.join(root, "renderer", file), path.join(fixture, file));
      const result = spawnSync(
        "bun",
        ["run", "test", path.relative(web, path.join(fixture, "local-code.test.tsx"))],
        {
          cwd: web,
          encoding: "utf8",
          timeout: 55000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  },
);
