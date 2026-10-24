const { contextBridge, ipcRenderer } = require("electron");

const STATES = new Set([
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "acting",
  "error",
  "idle",
]);
const commandListeners = new Set();
const dispatch = (command) => {
  for (const listener of commandListeners) listener(command);
};
ipcRenderer.on("ditto-live:command", (_event, command) => {
  if (["start", "stop", "mute", "unmute"].includes(command?.type)) dispatch({ type: command.type });
});

// Contract 2 in docs/ditto/live-mode.md.
contextBridge.exposeInMainWorld("dittoLive", {
  session: () => ipcRenderer.invoke("ditto-live:session"),
  captureScreen: (opts) => ipcRenderer.invoke("ditto-live:capture", opts),
  frontmost: () => ipcRenderer.invoke("ditto-live:frontmost"),
  tool: (name, args) => ipcRenderer.invoke("ditto-live:tool", name, args),
  setState: (state) => {
    if (STATES.has(state)) ipcRenderer.send("ditto-live:state", state);
  },
  setInteractive: (interactive) => ipcRenderer.send("ditto-live:interactive", interactive === true),
  stop: (reason) =>
    ipcRenderer.send(
      "ditto-live:stop",
      typeof reason === "string" ? reason.slice(0, 200) : undefined,
    ),
  onCommand: (listener) => {
    const handler = (command) => listener(command);
    commandListeners.add(handler);
    return () => commandListeners.delete(handler);
  },
});

// Window chrome for aura.html only: dragging and the hover mute toggle.
contextBridge.exposeInMainWorld("dittoAura", {
  drag: (phase) => {
    if (["start", "move", "end"].includes(phase)) ipcRenderer.send("ditto-live:aura-drag", phase);
  },
  setMuted: (muted) => dispatch({ type: muted === true ? "mute" : "unmute" }),
});
