const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldRetrieveMemory } = require("../src/task-context.cjs");

test("current file operations and literal replies do not receive unrelated historical snippets", () => {
  assert.equal(
    shouldRetrieveMemory("Read README.md in the selected project using your tools."),
    false,
  );
  assert.equal(shouldRetrieveMemory("Update app.ts in the working folder."), false);
  assert.equal(shouldRetrieveMemory("Reply exactly: DITTO_READY. Do not edit files."), false);
  assert.equal(shouldRetrieveMemory("Use my previous work and memory to update app.ts."), true);
  assert.equal(shouldRetrieveMemory("Find relevant context for the architecture of Ditto."), true);
});

test("an explicit request to omit memory takes precedence over memory keywords", () => {
  assert.equal(shouldRetrieveMemory("Read desktop-input.txt. Do not retrieve memories."), false);
  assert.equal(shouldRetrieveMemory("Explain this code without using my memory."), false);
  assert.equal(shouldRetrieveMemory("Inspect settings.json with no memory."), false);
  assert.equal(
    shouldRetrieveMemory("Use my previous work and memories to explain this code."),
    true,
  );
});
