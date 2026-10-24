// Aura orb view. Visual states are CSS (`data-state`); the only per-frame work
// is a transform/opacity write driven by the mic or speaker level, and that
// rAF loop runs only in listening/speaking and stops otherwise.

const LEVEL_STATES = new Set(["listening", "speaking"]);
const LABELS = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  acting: "Working on your computer",
  error: "Something went wrong",
  idle: "Live mode is off",
};

const MIC_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3"/><path class="ditto-aura-slash" d="M4 4l16 16"/></svg>';
const STOP_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

// `embedded` renders only the orb into a host the aura shell owns; the shell
// then handles hover, click-through, dragging, mute and stop itself.
export function createOrbView({ root, levels, embedded = false, onMute, onStop, onInteractive }) {
  const el = document.createElement("div");
  el.className = embedded ? "ditto-aura is-embedded" : "ditto-aura";
  el.dataset.state = "idle";
  el.innerHTML = `
    <div class="ditto-aura-glow"></div>
    <div class="ditto-aura-ring"></div>
    <div class="ditto-aura-core" role="img"><div class="ditto-aura-sheen"></div></div>`;
  if (!embedded) {
    el.insertAdjacentHTML(
      "beforeend",
      `<div class="ditto-aura-controls">
      <button type="button" class="ditto-aura-button ditto-aura-mute" aria-label="Mute microphone">${MIC_ICON}</button>
      <button type="button" class="ditto-aura-button ditto-aura-stop" aria-label="Stop live mode">${STOP_ICON}</button>
    </div>`,
    );
  }
  root.append(el);

  const glow = el.querySelector(".ditto-aura-glow");
  const core = el.querySelector(".ditto-aura-core");
  const muteButton = el.querySelector(".ditto-aura-mute");
  const reducedMotion =
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

  let state = "idle";
  let muted = false;
  let frame = null;
  let shown = 0;

  function loop() {
    const target = state === "speaking" ? levels.output() : muted ? 0 : levels.input();
    // Fast attack, slow release reads as "breathing" instead of jitter.
    const next = shown + (target - shown) * (target > shown ? 0.5 : 0.12);
    if (Math.abs(next - shown) > 0.004) {
      shown = next;
      core.style.transform = `scale(${1 + shown * 0.1})`;
      glow.style.transform = `scale(${1 + shown * 0.45})`;
      glow.style.opacity = String(0.55 + shown * 0.45);
    }
    frame = requestAnimationFrame(loop);
  }

  function syncLoop() {
    const wants = !reducedMotion && LEVEL_STATES.has(state) && !(state === "listening" && muted);
    if (wants && frame === null) frame = requestAnimationFrame(loop);
    if (!wants && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
      shown = 0;
      core.style.transform = glow.style.transform = glow.style.opacity = "";
    }
  }

  // Standalone (dev.html, or a window without the shell's chrome): the orb
  // takes the mouse only while hovered so the rest stays click-through.
  if (!embedded) {
    el.addEventListener("pointerenter", () => onInteractive(true));
    el.addEventListener("pointerleave", () => onInteractive(false));
    muteButton.addEventListener("click", () => onMute());
    el.querySelector(".ditto-aura-stop").addEventListener("click", () => onStop());
  }

  return {
    setState(next) {
      state = next;
      el.dataset.state = next;
      core.setAttribute("aria-label", `Ditto live: ${LABELS[next] || next}`);
      syncLoop();
    },
    setMuted(value) {
      muted = value;
      el.classList.toggle("is-muted", value);
      muteButton?.setAttribute("aria-label", value ? "Unmute microphone" : "Mute microphone");
      muteButton?.setAttribute("aria-pressed", String(value));
      syncLoop();
    },
    destroy() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      el.remove();
    },
  };
}
