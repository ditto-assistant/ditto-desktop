(() => {
  const aura = document.getElementById("aura");
  const orb = document.getElementById("aura-orb");
  const mute = document.getElementById("aura-mute");
  let interactive = false;
  let dragging = null;
  let muted = false;

  // The window ignores clicks on its transparent corners; forwarded mouse moves
  // tell us when the cursor is over something that should take the click.
  const setInteractive = (next) => {
    aura.classList.toggle("hover", next);
    if (next === interactive) return;
    interactive = next;
    window.dittoLive.setInteractive(next);
  };
  document.addEventListener("mousemove", (event) => {
    if (!dragging) setInteractive(Boolean(event.target.closest?.(".aura-hit")));
  });
  document.addEventListener("mouseleave", () => {
    if (!dragging) setInteractive(false);
  });

  orb.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = event.pointerId;
    orb.setPointerCapture(event.pointerId);
    window.dittoAura.drag("start");
  });
  orb.addEventListener("pointermove", (event) => {
    if (dragging === event.pointerId) window.dittoAura.drag("move");
  });
  const endDrag = (event) => {
    if (dragging !== event.pointerId) return;
    dragging = null;
    window.dittoAura.drag("end");
  };
  orb.addEventListener("pointerup", endDrag);
  orb.addEventListener("pointercancel", endDrag);

  mute.addEventListener("click", () => {
    muted = !muted;
    mute.setAttribute("aria-pressed", String(muted));
    const label = muted ? "Unmute microphone" : "Mute microphone";
    mute.title = label;
    mute.setAttribute("aria-label", label);
    aura.classList.toggle("muted", muted);
    window.dittoAura.setMuted(muted);
  });
  document.getElementById("aura-stop").addEventListener("click", () => {
    window.dittoLive.stop("aura-button");
  });
})();
