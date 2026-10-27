const fs = require("node:fs");
const path = require("node:path");

const MAX_DIAGNOSTIC_EVENTS = 128;
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;
const MAX_DIAGNOSTIC_RATE = 20;
const STATES = new Set([
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "acting",
  "error",
  "idle",
]);
const STOP_SOURCES = new Set([
  "user",
  "command",
  "window_closed",
  "destroyed",
  "session_ended",
  "resume_unavailable",
  "disconnected",
  "error",
  "other",
  "aura",
  "toggle",
  "signed-out",
  "sign-out",
  "computer-use-disabled",
  "computer-disabled",
  "suspend",
  "lock-screen",
  "quit",
  "start-failed",
  "disposed",
  "stopped",
  "aura-reloaded",
  "aura-closed",
  "aura-crashed",
  "aura-killed",
  "aura-oom",
  "aura-launch-failed",
  "aura-clean-exit",
  "aura-abnormal-exit",
  "aura-integrity-failure",
]);
const LIVE_TOOLS = new Set([
  "computer_click",
  "computer_type_text",
  "computer_press_key",
  "computer_scroll",
  "computer_drag",
  "computer_open_app",
  "computer_get_state",
  "ditto_app",
  "ditto_client_action",
  "ditto_client_context",
  "ditto_client_session",
]);
const NATIVE_TOOLS = new Set([
  "computer_get_desktop_state",
  "computer_list_windows",
  "computer_double_click",
  "computer_click",
  "computer_type_text",
  "computer_press_key",
  "computer_scroll",
  "computer_drag",
  "computer_launch_app",
  "computer_bring_to_front",
]);

function liveDiagnosticStopSource(reason) {
  if (typeof reason !== "string") return "other";
  if (reason.startsWith("error:")) return "error";
  return STOP_SOURCES.has(reason) ? reason : "other";
}

// Never spread an IPC payload or serialize an error/result. Even persisted
// records pass this allowlist again when the app starts.
function sanitizeLiveDiagnostic(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const generation = input.generation;
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0))
    return null;
  let entry;
  switch (input.event) {
    case "capability":
      if (
        !["available", "unavailable", "unknown"].includes(input.status) ||
        !Number.isInteger(input.count) ||
        input.count < 0 ||
        input.count > 8 ||
        (input.status === "available" ? input.count === 0 : input.count !== 0)
      )
        return null;
      entry = { event: "capability", status: input.status, count: input.count };
      break;
    case "state":
      if (!STATES.has(input.state)) return null;
      entry = { event: "state", state: input.state };
      break;
    case "stop":
      if (!STOP_SOURCES.has(input.source)) return null;
      entry = { event: "stop", source: input.source };
      break;
    case "socket_close":
      if (
        !Number.isInteger(input.code) ||
        input.code < 0 ||
        input.code > 65535 ||
        generation === undefined
      )
        return null;
      entry = { event: "socket_close", code: input.code };
      break;
    case "error":
      if (!["start", "server", "reconnect"].includes(input.errorClass)) return null;
      entry = { event: "error", errorClass: input.errorClass };
      break;
    case "tool":
    case "native_tool": {
      const tools = input.event === "tool" ? LIVE_TOOLS : NATIVE_TOOLS;
      if (!tools.has(input.tool) || !["ok", "error"].includes(input.outcome)) return null;
      entry = { event: input.event, tool: input.tool, outcome: input.outcome };
      if (input.event === "native_tool" && typeof input.verified === "boolean")
        entry.verified = input.verified;
      break;
    }
    default:
      return null;
  }
  if (generation !== undefined) entry.generation = generation;
  return entry;
}

function registerLiveDiagnosticIPC({ ipcMain, getAuraWindow, record }) {
  const listener = (event, entry) => {
    const window = getAuraWindow();
    if (!window || window.isDestroyed()) return;
    const contents = window.webContents;
    if (event?.sender !== contents || event.senderFrame !== contents.mainFrame) return;
    record(entry);
  };
  ipcMain.on("ditto-live:diagnostic", listener);
  return () => ipcMain.removeListener("ditto-live:diagnostic", listener);
}

function createLiveDiagnostics(file, { now = Date.now } = {}) {
  let entries = [];
  try {
    const info = fs.lstatSync(file);
    if (info.isFile() && info.size <= MAX_DIAGNOSTIC_BYTES) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved))
        entries = saved.map(sanitizeLiveDiagnostic).filter(Boolean).slice(-MAX_DIAGNOSTIC_EVENTS);
    }
  } catch {}
  let windowStart = now();
  let writes = 0;
  const terminalEvents = new Set();
  return {
    record(input) {
      try {
        const entry = sanitizeLiveDiagnostic(input);
        if (!entry) return false;
        const current = now();
        if (current - windowStart >= 1000 || current < windowStart) {
          windowStart = current;
          writes = 0;
          terminalEvents.clear();
        }
        // Reserve one write for each terminal class so an ordinary action burst
        // cannot hide the close/error/stop that this log is meant to explain.
        if (["stop", "socket_close", "error"].includes(entry.event)) {
          if (terminalEvents.has(entry.event)) return false;
          terminalEvents.add(entry.event);
        } else {
          if (writes >= MAX_DIAGNOSTIC_RATE - 3) return false;
          writes++;
        }
        entries.push(entry);
        entries = entries.slice(-MAX_DIAGNOSTIC_EVENTS);
        let data = JSON.stringify(entries);
        while (Buffer.byteLength(data) > MAX_DIAGNOSTIC_BYTES) {
          entries.shift();
          data = JSON.stringify(entries);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(
          file,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fs.fchmodSync(fd, 0o600);
          fs.writeFileSync(fd, data);
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch {
        // Diagnostics must never interrupt a call or prevent the user stopping it.
        return false;
      }
    },
  };
}

module.exports = {
  createLiveDiagnostics,
  registerLiveDiagnosticIPC,
  sanitizeLiveDiagnostic,
  liveDiagnosticStopSource,
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_RATE,
};
