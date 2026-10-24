// STUB owned by the desktop-live-bridge workstream; replace wholesale with the
// real bridge. It implements only the registration shape from Contract 2 in
// docs/ditto/live-mode.md so the aura shell can be exercised on its own.
function registerLiveBridge({ ipcMain, getAuraWindow, getSession }) {
  const stopListeners = new Set();
  const fromAura = (event) => event.sender === getAuraWindow()?.webContents;
  const unavailable = async () => {
    throw new Error("The live bridge is not installed yet.");
  };
  ipcMain.handle("ditto-live:session", (event) => {
    if (!fromAura(event)) throw new Error("Only the Live aura can request a session.");
    return getSession();
  });
  ipcMain.handle("ditto-live:capture", unavailable);
  ipcMain.handle("ditto-live:frontmost", unavailable);
  ipcMain.handle("ditto-live:tool", async () => ({
    ok: false,
    error: "The live bridge is not installed yet.",
  }));
  const onState = () => {};
  const onStop = (event, reason) => {
    if (!fromAura(event)) return;
    for (const listener of stopListeners) listener(reason);
  };
  ipcMain.on("ditto-live:state", onState);
  ipcMain.on("ditto-live:stop", onStop);
  return {
    onStop(listener) {
      stopListeners.add(listener);
      return () => stopListeners.delete(listener);
    },
    dispose() {
      for (const channel of [
        "ditto-live:session",
        "ditto-live:capture",
        "ditto-live:frontmost",
        "ditto-live:tool",
      ])
        ipcMain.removeHandler(channel);
      ipcMain.removeListener("ditto-live:state", onState);
      ipcMain.removeListener("ditto-live:stop", onStop);
      stopListeners.clear();
    },
  };
}

module.exports = { registerLiveBridge };
