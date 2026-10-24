// Aura window entry point. aura.html loads this as a module next to aura.css;
// it mounts on the preload's `window.dittoLive` and waits for main's `start`.

import { createAudioEngine } from "./audio.js";
import { createOrbView } from "./orb.js";
import { createLiveSession } from "./session.js";

export function mountAura({
  live = globalThis.dittoLive,
  // aura.html (desktop-aura-shell) provides #aura-orb and owns the window chrome.
  host = document.getElementById("aura-orb"),
  audio = createAudioEngine(),
  WebSocket = globalThis.WebSocket,
  frameIntervalMs,
  idlePauseMs,
} = {}) {
  if (!live) throw new Error("window.dittoLive is not available in this window");

  const log = (...args) => console.info("[ditto-live]", ...args);
  let session = null;

  const view = createOrbView({
    root: host || document.body,
    embedded: Boolean(host),
    levels: { input: () => audio.inputLevel(), output: () => audio.outputLevel() },
    onMute: () => session?.toggleMute(),
    onStop: () => {
      if (session?.active) void session.stop("user");
      else live.stop("user");
    },
    onInteractive: (interactive) => live.setInteractive(interactive),
  });

  session = createLiveSession({
    live,
    audio,
    WebSocket,
    log,
    frameIntervalMs,
    idlePauseMs,
    onState: (state) => view.setState(state),
    onMuted: (value) => view.setMuted(value),
  });

  const unsubscribe = live.onCommand((command) => {
    switch (command && command.type) {
      case "start":
        void session.start();
        break;
      case "stop":
        void session.stop("command");
        break;
      case "mute":
        session.setMuted(true);
        break;
      case "unmute":
        session.setMuted(false);
        break;
      case "context_changed":
        session.contextChanged();
        break;
    }
  });

  addEventListener("pagehide", () => {
    if (session.active) void session.stop("window_closed");
  });

  return {
    session,
    destroy() {
      unsubscribe();
      if (session.active) void session.stop("destroyed");
      view.destroy();
    },
  };
}

// dev.html mounts manually with mocks; the real aura window mounts here.
if (globalThis.dittoLive && !globalThis.dittoLiveDev) {
  const start = () => mountAura();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
}
