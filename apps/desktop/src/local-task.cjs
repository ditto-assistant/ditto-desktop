const { spawn } = require("node:child_process");
const os = require("node:os");

const tasks = new WeakMap();

function spawnLocalTask(command, args, { cancelSignal = "SIGTERM", ...options }) {
  // Each task owns its process group. Stop must include tool subprocesses,
  // without signalling Desktop itself or another coding task.
  const grouped = os.platform() !== "win32";
  const child = spawn(command, args, { ...options, detached: grouped });
  const state = { cancelled: false, timer: null, grouped, cancelSignal };
  tasks.set(child, state);
  child.once("exit", () => {
    clearTimeout(state.timer);
    if (state.cancelled) {
      try {
        signalTask(child, "SIGKILL");
      } catch (error) {
        // Exit callbacks cannot throw safely; task consumers already handle child errors.
        child.emit("error", error);
      }
    }
  });
  child.once("error", () => clearTimeout(state.timer));
  return child;
}

function signalTask(child, signal) {
  const state = tasks.get(child);
  if (!state || !Number.isInteger(child.pid) || child.pid <= 0) return;
  try {
    // This is the group ID captured by our own spawn, never a process search.
    if (state.grouped) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function cancelLocalTask(child) {
  const state = child && tasks.get(child);
  if (!state || child.exitCode !== null || child.signalCode !== null) return false;
  if (state.cancelled) return true;
  state.cancelled = true;
  signalTask(child, state.cancelSignal);
  state.timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalTask(child, "SIGKILL");
  }, 2000);
  state.timer.unref();
  return true;
}

function wasLocalTaskCancelled(child) {
  return tasks.get(child)?.cancelled === true;
}

module.exports = { spawnLocalTask, cancelLocalTask, wasLocalTaskCancelled };
