const electron = require("electron");
const { BrowserWindow, ipcMain, session, systemPreferences } = electron;
const os = require("node:os");
const path = require("node:path");
const { AURA_SIZE, clampAuraPosition } = require("./aura-controller.cjs");

const AURA_PARTITION = "ditto-live-aura";
const POSITION_SETTING = "liveAuraPosition";
// The client waits up to a second for the server to acknowledge stop_session.
const STOP_GRACE_MS = 1500;

// `screen` may only be read once the app is ready.
const workAreas = () => {
  const { screen } = electron;
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((item) => item.id !== primary.id)].map(
    (item) => item.workArea,
  );
};

async function ensureMicrophoneAccess() {
  if (os.platform() !== "darwin") return true;
  if (systemPreferences.getMediaAccessStatus("microphone") === "granted") return true;
  return systemPreferences.askForMediaAccess("microphone");
}

// The aura's own session only ever grants microphone capture to the aura page.
function restrictPermissions(auraSession, isAura) {
  const allowed = (webContents, permission, details) =>
    permission === "media" &&
    isAura(webContents) &&
    (details?.mediaTypes ?? ["audio"]).every((type) => type === "audio");
  auraSession.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(allowed(webContents, permission, details)),
  );
  auraSession.setPermissionCheckHandler(
    (webContents, permission, _origin, details) =>
      permission === "media" && isAura(webContents) && details?.mediaType !== "video",
  );
}

function createAuraWindow({ getSetting, setSetting }) {
  let window = null;
  let drag = null;
  const auraSession = session.fromPartition(AURA_PARTITION);
  const isAura = (webContents) =>
    Boolean(window && !window.isDestroyed() && webContents === window.webContents);
  restrictPermissions(auraSession, isAura);

  const trusted = (event) => isAura(event.sender) && event.senderFrame === event.sender.mainFrame;
  const savePosition = () => {
    if (!window || window.isDestroyed()) return;
    const [x, y] = window.getPosition();
    const next = clampAuraPosition({ x, y }, workAreas());
    if (next.x !== x || next.y !== y) window.setPosition(next.x, next.y);
    setSetting(POSITION_SETTING, next);
  };
  // The renderer reports drag phases; main reads the cursor itself so window
  // movement stays in global screen points across displays with mixed scale.
  const onDrag = (event, phase) => {
    if (!trusted(event)) return;
    const cursor = electron.screen.getCursorScreenPoint();
    if (phase === "start") {
      const [x, y] = window.getPosition();
      drag = { cursor, x, y };
    } else if (phase === "move" && drag) {
      window.setPosition(drag.x + cursor.x - drag.cursor.x, drag.y + cursor.y - drag.cursor.y);
    } else if (phase === "end") {
      drag = null;
      savePosition();
    }
  };
  ipcMain.on("ditto-live:aura-drag", onDrag);

  const open = async () => {
    if (window && !window.isDestroyed()) return window;
    await ensureMicrophoneAccess();
    const { x, y } = clampAuraPosition(getSetting(POSITION_SETTING, null), workAreas());
    window = new BrowserWindow({
      x,
      y,
      width: AURA_SIZE,
      height: AURA_SIZE,
      ...(os.platform() === "darwin" ? { type: "panel" } : {}),
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      title: "Ditto Live",
      webPreferences: {
        preload: path.join(__dirname, "aura-preload.cjs"),
        partition: AURA_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // Audio, frames and tool replies keep running while another app is frontmost.
        backgroundThrottling: false,
      },
    });
    const current = window;
    current.setAlwaysOnTop(true, "screen-saver");
    current.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    // Keeps the aura out of screen frames sent to the model.
    current.setContentProtection(true);
    current.setIgnoreMouseEvents(true, { forward: true });
    current.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    current.webContents.on("will-navigate", (event) => event.preventDefault());
    current.on("closed", () => {
      if (window === current) window = null;
      drag = null;
    });
    current.once("ready-to-show", () => {
      if (!current.isDestroyed()) current.showInactive();
    });
    await current.loadFile(path.join(__dirname, "aura.html"));
    return current;
  };

  // Main's stop reaches the client as a `stop` command; it then sends
  // stop_session and reports back through `ditto-live:stop`. A socket that just
  // drops is parked by the server for resume and never summarized into memory,
  // so hide at once but keep the page alive until it has said goodbye.
  const close = () => {
    const current = window;
    window = null;
    drag = null;
    if (!current || current.isDestroyed()) return;
    const contents = current.webContents;
    let timer;
    const finish = (event) => {
      if (event && event.sender !== contents) return;
      clearTimeout(timer);
      ipcMain.removeListener("ditto-live:stop", finish);
      if (!current.isDestroyed()) current.destroy();
    };
    timer = setTimeout(finish, STOP_GRACE_MS);
    ipcMain.on("ditto-live:stop", finish);
    current.hide();
  };

  return {
    open,
    close,
    get window() {
      return window && !window.isDestroyed() ? window : null;
    },
    dispose() {
      close();
      ipcMain.removeListener("ditto-live:aura-drag", onDrag);
    },
  };
}

module.exports = { createAuraWindow };
