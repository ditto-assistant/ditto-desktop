// PLACEHOLDER owned by the desktop-live-client workstream; replace wholesale.
// It only renders a pulsing orb so the aura window can be exercised alone.
const orb = document.getElementById("aura-orb");
const style = document.createElement("style");
style.textContent = `
  .placeholder-orb { width: 100%; height: 100%; border-radius: 50%;
    background: radial-gradient(circle at 35% 30%, #c9b6ff, #6d4cff 55%, #2b1a7a);
    box-shadow: 0 0 28px 6px rgb(120 90 255 / 0.55);
    animation: placeholder-pulse 2.4s ease-in-out infinite; }
  .muted .placeholder-orb { filter: grayscale(0.8); animation: none; }
  @keyframes placeholder-pulse { 50% { transform: scale(0.92); opacity: 0.85; } }
`;
document.head.append(style);
const inner = document.createElement("div");
inner.className = "placeholder-orb";
orb.append(inner);
window.dittoLive.onCommand((command) => {
  if (command.type === "start") window.dittoLive.setState("listening");
});
