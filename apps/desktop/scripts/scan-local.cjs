const os = require("node:os");
const path = require("node:path");
const { MemoryStore, defaultCodeRoots } = require("../src/memory.cjs");

async function main() {
  const dataDir = path.join(os.homedir(), "Library", "Application Support", "hey-ditto-local");
  const store = new MemoryStore(dataDir);
  try {
    const roots = store.getSetting("codeRoots", defaultCodeRoots());
    const result = await store.scan({
      roots,
      progress: (message) => process.stdout.write(`${message}\n`),
    });
    const native = require("../native/ditto-harness.node");
    const harness = await native.Harness.open(path.join(dataDir, "ditto-harness.sqlite"), {
      embedder: "hash",
    });
    result.memoriesAdded = await store.syncHarness(harness);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
