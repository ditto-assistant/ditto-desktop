const test = require("node:test");
const assert = require("node:assert/strict");

test("web chats receive no local capability, and sign-out revokes a pending token", async () => {
  const { desktopComputerMetadata, connectDesktopComputer } =
    await import("../renderer/desktopComputer.ts");
  global.window = {};
  assert.deepEqual(desktopComputerMetadata(), {});
  const links = [];
  let listener;
  let tokenReady;
  const token = new Promise((resolve) => {
    tokenReady = resolve;
  });
  let requested;
  const tokenRequested = new Promise((resolve) => {
    requested = resolve;
  });
  let lease = "fixture-lease";
  window.ditto = {
    computerStatus: async () => ({ enabled: false }),
    computerLease: () => lease,
    computerCloudLink: async (value) => {
      links.push(value);
      if (value === null) lease = "";
    },
    onComputerEnabled: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  assert.deepEqual(desktopComputerMetadata(), { desktopComputerLease: "fixture-lease" });
  const disconnect = connectDesktopComputer({
    getIdToken: () => {
      requested();
      return token;
    },
  });
  listener(true);
  await tokenRequested;
  disconnect();
  tokenReady("fixture-token-that-must-not-connect");
  await token;
  assert.deepEqual(links, [null]);
  assert.equal(listener, null);
  assert.deepEqual(desktopComputerMetadata(), {});
  delete global.window;
});
