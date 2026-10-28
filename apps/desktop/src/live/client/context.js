// Frontmost-app context notes. The agent sees the screen, but a short text
// note on app switches tells it where the user went without guessing from pixels.

export const FRONTMOST_POLL_MS = 1000;
const MAX_TITLE = 120;

function clip(text) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > MAX_TITLE ? `${value.slice(0, MAX_TITLE - 1)}…` : value;
}

// Ditto's own window titles change with navigation; only "in Ditto or not" matters there.
export function frontmostKey(info) {
  if (!info) return "";
  if (info.isDitto) return "ditto";
  return `${info.bundleId || info.app || ""}\u0000${clip(info.title)}`;
}

export function describeFrontmost(previous, next) {
  if (!next || (!next.isDitto && !next.app)) return null;
  if (previous && frontmostKey(previous) === frontmostKey(next)) return null;
  if (next.isDitto) {
    return previous ? "User returned to the Ditto app" : "User is in the Ditto app";
  }
  const title = clip(next.title);
  return title ? `User is now in ${next.app} – "${title}"` : `User is now in ${next.app}`;
}

export function createFrontmostWatcher({
  frontmost,
  onChange,
  intervalMs = FRONTMOST_POLL_MS,
  setInterval: startInterval = globalThis.setInterval,
  clearInterval: stopInterval = globalThis.clearInterval,
}) {
  let timer = null;
  let last = null;
  let inFlight = false;

  async function poll() {
    if (inFlight) return;
    inFlight = true;
    try {
      const info = await frontmost();
      if (timer === null) return;
      const text = describeFrontmost(last, info);
      if (info) last = info;
      if (text) onChange(text, info);
    } catch {
      // A transient failure keeps the last known app; the next poll retries.
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer !== null) return;
      timer = startInterval(poll, intervalMs);
      return poll();
    },
    stop() {
      if (timer !== null) stopInterval(timer);
      timer = null;
      last = null;
    },
    poll,
  };
}
