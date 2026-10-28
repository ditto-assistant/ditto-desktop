const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("computerSetup", {
  action: (action, permission) =>
    ipcRenderer.invoke("ditto:computer-setup-action", action, permission),
  drag: () => ipcRenderer.send("ditto:computer-setup-drag"),
});
