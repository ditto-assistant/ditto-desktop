const test = require("node:test");
const assert = require("node:assert/strict");
const { createComputerControl } = require("../src/computer.cjs");

test("computer actions require a fresh snapshot and carry the observed app and target identity", async () => {
  let calls = [];
  let foreground = { bundleId: "com.example.qa", pid: 42 };
  const computer = createComputerControl({
    getHelper: () => process.execPath,
    execute: async (_binary, args) => {
      calls.push(args);
      const result =
        args[0] === "snapshot"
          ? {
              ...foreground,
              elements: [{ ref: "w0.1", role: "AXButton", title: "QA", description: "" }],
            }
          : args[0] === "status"
            ? foreground
            : { clicked: true };
      return { stdout: JSON.stringify(result) };
    },
  });
  await assert.rejects(computer("click", "w0.1"), /Inspect the current app/);
  assert.equal(calls.length, 0);
  await computer("snapshot");
  await computer("click", "w0.1");
  const expected = JSON.parse(calls.at(-1).at(-1));
  assert.deepEqual(expected, {
    bundleId: "com.example.qa",
    pid: 42,
    role: "AXButton",
    title: "QA",
    description: "",
  });
  await assert.rejects(computer("click", "w0.1"), /Inspect the current app/);
  await computer("snapshot");
  foreground = { bundleId: "com.example.other", pid: 99 };
  await computer("status");
  await assert.rejects(computer("set", "w0.1", "text"), /Inspect the current app/);
  await computer("snapshot");
  await computer("activate", "com.example.qa");
  await assert.rejects(computer("click", "w0.1"), /Inspect the current app/);
});
