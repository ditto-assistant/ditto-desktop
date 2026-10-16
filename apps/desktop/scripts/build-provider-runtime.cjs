const path = require("node:path");
const { spawnSync } = require("node:child_process");

const result = spawnSync("vp", ["pack"], {
  cwd: path.resolve(__dirname, "../../server"),
  stdio: "inherit",
  env: { ...process.env, DITTO_DESKTOP_PROVIDER_BUILD: "1" },
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Coding provider runtime build failed.");
