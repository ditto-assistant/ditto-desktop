const { BrowserWindow, ipcMain, shell, nativeImage } = require("electron");
const path = require("node:path");

function createComputerSetup(service, cloudStatus = () => ({})) {
  const status = async () => ({ ...(await service.status()), cloud: cloudStatus() });
  let window;
  const panes = {
    accessibility: "Privacy_Accessibility",
    screenRecording: "Privacy_ScreenCapture",
  };
  const show = () => {
    if (window && !window.isDestroyed()) {
      window.show();
      return;
    }
    window = new BrowserWindow({
      width: 400,
      height: 700,
      resizable: false,
      title: "Computer Use · Ditto",
      backgroundColor: "#101113",
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, "computer-setup-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => {
      window = null;
    });
    void window.loadFile(path.join(__dirname, "computer-setup.html"));
  };
  const trusted = (event) => window && !window.isDestroyed() && event.sender === window.webContents;
  ipcMain.handle("ditto:computer-setup-action", async (event, action, permission) => {
    if (!trusted(event)) throw new Error("Open Computer Use setup first.");
    switch (action) {
      case "icon":
        return nativeImage
          .createFromPath(path.join(service.paths.app, "Contents", "Resources", "Ditto.png"))
          .toDataURL();
      case "status":
        return status();
      case "prepare":
        await service.prepare();
        return status();
      case "enable":
        await service.enable();
        return status();
      case "stop":
        await service.stop();
        return status();
      case "restart":
        await service.restart();
        return status();
      case "settings":
        if (!panes[permission]) throw new Error("Choose a permission to set up.");
        await service.prepare();
        await shell.openExternal(
          `x-apple.systempreferences:com.apple.preference.security?${panes[permission]}`,
        );
        window?.setAlwaysOnTop(true, "floating");
        window?.showInactive();
        return status();
      default:
        throw new Error("Unsupported setup action.");
    }
  });
  ipcMain.on("ditto:computer-setup-drag", (event) => {
    if (!trusted(event)) return;
    event.sender.startDrag({
      file: service.paths.app,
      icon: nativeImage
        .createFromPath(path.join(service.paths.app, "Contents", "Resources", "Ditto.png"))
        .resize({ width: 64, height: 64 }),
    });
  });
  return { show };
}

module.exports = { createComputerSetup };
