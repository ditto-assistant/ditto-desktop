const os = require("node:os");
const fs = require("node:fs");
const NodeProcess = require("node:process");

// Terminals belong to Code conversations, not to whichever pane is currently visible.
class DesktopTerminal {
  constructor({ onEvent, spawn = (...args) => require("@lydell/node-pty").spawn(...args) }) {
    this.onEvent = onEvent;
    this.spawn = spawn;
    this.sessions = new Map();
  }

  open(key, cwd, cols = 80, rows = 24) {
    if (typeof key !== "string" || !/^[\w:-]{1,120}$/.test(key))
      throw new Error("Invalid terminal conversation.");
    const existing = this.sessions.get(key);
    if (existing) return { key, cwd: existing.cwd, output: existing.output };
    if (this.sessions.size >= 8) throw new Error("Close a terminal before opening another.");
    if (!fs.statSync(cwd).isDirectory()) throw new Error("The working folder is unavailable.");
    const shell =
      os.platform() === "win32"
        ? "powershell.exe"
        : NodeProcess.env.SHELL || (os.platform() === "darwin" ? "/bin/zsh" : "/bin/sh");
    const child = this.spawn(shell, os.platform() === "win32" ? [] : ["-l"], {
      name: "xterm-256color",
      cwd,
      cols: this.dimension(cols, 500),
      rows: this.dimension(rows, 250),
      env: { ...NodeProcess.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    const session = { child, cwd, output: "" };
    this.sessions.set(key, session);
    child.onData((data) => {
      if (this.sessions.get(key) !== session) return;
      session.output = (session.output + data).slice(-200000);
      this.onEvent({ key, type: "data", data });
    });
    child.onExit(({ exitCode }) => {
      if (this.sessions.get(key) !== session) return;
      this.sessions.delete(key);
      this.onEvent({ key, type: "exit", exitCode });
    });
    return { key, cwd, output: session.output };
  }

  dimension(value, max) {
    if (!Number.isInteger(value) || value < 2 || value > max)
      throw new Error("Invalid terminal dimensions.");
    return value;
  }

  write(key, data) {
    if (typeof data !== "string" || data.length > 65536) throw new Error("Invalid terminal input.");
    const session = this.sessions.get(key);
    if (!session) throw new Error("Open the terminal first.");
    session.child.write(data);
  }

  resize(key, cols, rows) {
    this.sessions.get(key)?.child.resize(this.dimension(cols, 500), this.dimension(rows, 250));
  }

  close(key) {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    session.child.kill();
    this.onEvent({ key, type: "exit", exitCode: null });
  }

  closeAll() {
    for (const key of this.sessions.keys()) this.close(key);
  }
}

module.exports = { DesktopTerminal };
