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

test("memory opt-outs also apply to coordinated lists of prohibited actions", () => {
  for (const prompt of [
    "Use the bash tool to run exactly pwd. Do not change files, access the network, or retrieve memories.",
    "Don't change files or use my memory to answer this.",
    "Do not access the network, use tools, nor recall local memories.",
    "Do not edit files or include memory.",
  ])
    assert.equal(shouldRetrieveMemory(prompt), false, prompt);
});

test("a separate request to use memory is not negated by a preceding prohibition", () => {
  for (const prompt of [
    "Do not edit files. Recall my memories or history to explain this.",
    "Don't run commands; retrieve memories or history instead.",
    "Do not edit files\nUse memory or history to explain this.",
  ])
    assert.equal(shouldRetrieveMemory(prompt), true, prompt);
});
