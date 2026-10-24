// Screen frame cadence: one frame per interval while connected, never two
// captures in flight, a fresh frame right after each tool action, and no
// frames at all once the user is muted and nothing has happened for a while
// (a muted, quiet session has nobody to look at the screen for; any agent
// activity or unmuting resumes frames immediately).

export const FRAME_INTERVAL_MS = 1000;
export const IDLE_PAUSE_MS = 30_000;

export function createFrameScheduler({
  capture,
  send,
  onError = () => {},
  intervalMs = FRAME_INTERVAL_MS,
  idlePauseMs = IDLE_PAUSE_MS,
  now = Date.now,
  setInterval: startInterval = globalThis.setInterval,
  clearInterval: stopInterval = globalThis.clearInterval,
}) {
  let timer = null;
  let inFlight = null;
  // Set when a fresh frame is wanted while a capture is already running: that
  // capture began before the action, so its pixels may be stale.
  let wantFresh = null;
  let muted = false;
  let lastActivity = now();
  let running = false;

  const paused = () => muted && now() - lastActivity >= idlePauseMs;

  function shoot() {
    inFlight = (async () => {
      try {
        const frame = await capture();
        if (running && frame && frame.data) send(frame);
      } catch (error) {
        onError(error);
      }
    })().finally(() => {
      inFlight = null;
      if (wantFresh && running) {
        const waiter = wantFresh;
        wantFresh = null;
        shoot();
        inFlight.then(waiter.resolve);
      } else if (wantFresh) {
        wantFresh.resolve();
        wantFresh = null;
      }
    });
    return inFlight;
  }

  function tick() {
    if (!running || inFlight || paused()) return;
    void shoot();
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastActivity = now();
      timer = startInterval(tick, intervalMs);
      tick();
    },
    stop() {
      running = false;
      if (timer !== null) stopInterval(timer);
      timer = null;
      if (wantFresh) {
        wantFresh.resolve();
        wantFresh = null;
      }
    },
    // Resolves once a frame captured after this call has been sent (or failed).
    captureNow() {
      lastActivity = now();
      if (!running) return Promise.resolve();
      if (!inFlight) return shoot();
      if (!wantFresh) {
        let resolve;
        const promise = new Promise((r) => (resolve = r));
        wantFresh = { promise, resolve };
      }
      return wantFresh.promise;
    },
    noteActivity() {
      const wasPaused = paused();
      lastActivity = now();
      if (wasPaused) tick();
    },
    setMuted(value) {
      const wasPaused = paused();
      muted = value;
      lastActivity = now();
      if (wasPaused && !paused()) tick();
    },
    isPaused: paused,
    isCapturing: () => inFlight !== null,
  };
}
