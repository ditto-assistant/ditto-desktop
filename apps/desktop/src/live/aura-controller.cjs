const { randomUUID } = require("node:crypto");

const AURA_SIZE = 180;
const AURA_MARGIN = 24;

function defaultAuraPosition(workArea, size = AURA_SIZE) {
  return {
    x: Math.round(workArea.x + workArea.width - size - AURA_MARGIN),
    y: Math.round(workArea.y + workArea.height - size - AURA_MARGIN),
  };
}

// Keeps a remembered position on the display it was saved on. A display that
// has since been unplugged sends the aura to the primary display's corner.
function clampAuraPosition(saved, workAreas, size = AURA_SIZE) {
  const primary = workAreas[0];
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y))
    return defaultAuraPosition(primary, size);
  const centerX = saved.x + size / 2;
  const centerY = saved.y + size / 2;
  const area = workAreas.find(
    (item) =>
      centerX >= item.x &&
      centerX < item.x + item.width &&
      centerY >= item.y &&
      centerY < item.y + item.height,
  );
  if (!area) return defaultAuraPosition(primary, size);
  const clamp = (value, start, length) =>
    Math.round(Math.min(Math.max(value, start), start + Math.max(length - size, 0)));
  return {
    x: clamp(saved.x, area.x, area.width),
    y: clamp(saved.y, area.y, area.height),
  };
}

// One live session at a time. Every start owns a generation so a stop that
// arrives while the aura is still opening wins over the late open.
function createLiveController({
  isComputerEnabled,
  openComputerSetup,
  prepare = async () => {},
  open,
  close,
  onActive = () => {},
  newSessionId = randomUUID,
}) {
  let state = "idle";
  let generation = 0;
  let sessionId = null;
  let starting = false;

  const setState = (next) => {
    const wasActive = state !== "idle";
    state = next;
    if (wasActive !== (next !== "idle")) onActive(next !== "idle");
  };

  const start = async () => {
    if (state !== "idle" || starting) return { started: false, reason: "running" };
    if (!(await isComputerEnabled())) {
      openComputerSetup();
      return { started: false, reason: "computer-disabled" };
    }
    if (state !== "idle" || starting) return { started: false, reason: "running" };
    const owner = ++generation;
    sessionId = newSessionId();
    // Stop hides immediately, but the old open must drain before shared aura/bridge
    // resources can belong to a new start. Its late cleanup would close the new one.
    starting = true;
    setState("starting");
    try {
      try {
        await prepare(sessionId);
        if (owner !== generation) return { started: false, reason: "stopped" };
        await open(sessionId);
      } catch (error) {
        if (owner !== generation) {
          await close("stopped");
          return { started: false, reason: "stopped" };
        }
        await stop("start-failed");
        throw error;
      }
      if (owner !== generation) {
        // Stop already ran while the aura was opening; tear down what the open created.
        await close("stopped");
        return { started: false, reason: "stopped" };
      }
      setState("active");
      return { started: true, sessionId };
    } finally {
      starting = false;
    }
  };

  const stop = async (reason = "user") => {
    if (state === "idle") return false;
    ++generation;
    sessionId = null;
    setState("idle");
    await close(reason);
    return true;
  };

  return {
    start,
    stop,
    toggle: () => (state === "idle" ? start() : stop("toggle")),
    get state() {
      return state;
    },
    get sessionId() {
      return sessionId;
    },
  };
}

// Main asks the signed-in Ditto renderer for a Firebase ID token by id and
// waits for the matching reply. The token never touches disk.
function createTokenRequester({ send, timeoutMs = 20000, newId = randomUUID }) {
  const pending = new Map();
  const request = () =>
    new Promise((resolve, reject) => {
      const id = newId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Sign in to Ditto Desktop before starting Live."));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        if (!send(id)) throw new Error("Open Ditto Desktop before starting Live.");
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  const resolve = (id, reply) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (typeof reply?.token === "string" && reply.token) entry.resolve(reply.token);
    else
      entry.reject(
        new Error(
          typeof reply?.error === "string" && reply.error
            ? reply.error.slice(0, 300)
            : "Sign in to Ditto Desktop before starting Live.",
        ),
      );
    return true;
  };
  return { request, resolve };
}

// The aura closes itself when a session fails, so the reason it sends is the
// only explanation the user gets. Stops the user asked for stay silent.
function liveStopNotice(reason) {
  if (typeof reason !== "string") return null;
  if (reason === "disconnected") return "Live lost its connection to Ditto. Try starting it again.";
  if (reason === "resume_unavailable") return "Live could not resume this session. Start it again.";
  if (reason.startsWith("error:")) return reason.slice("error:".length).trim() || "Live stopped.";
  return null;
}

module.exports = {
  AURA_SIZE,
  clampAuraPosition,
  createLiveController,
  createTokenRequester,
  liveStopNotice,
};
