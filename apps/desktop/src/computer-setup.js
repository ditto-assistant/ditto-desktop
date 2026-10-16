const $ = (id) => document.getElementById(id);
let busy = false;
let generation = 0;
function render(status) {
  for (const key of ["accessibility", "screenRecording"])
    $(key).textContent = status[key] ? "Allowed" : "Allow in macOS Settings";
  $("enable").disabled = busy || !status.accessibility || !status.screenRecording || status.enabled;
  $("stop").disabled = busy || !status.running;
  $("status").textContent = status.enabled
    ? status.cloud?.connected
      ? "Computer Use is on for Ditto Code and your Ditto agents."
      : "Computer Use is on for local Ditto Code. Cloud agents are not connected."
    : status.running
      ? "Computer Use is off. Complete setup, then enable it."
      : "Computer Use is stopped.";
}
async function action(name, permission) {
  if (busy && name !== "stop") return;
  const owner = ++generation;
  busy = true;
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  $("stop").disabled = false;
  $("status").textContent =
    name === "restart" ? "Restarting only Ditto Computer Use…" : "Checking access…";
  try {
    const status = await window.computerSetup.action(name, permission);
    if (owner !== generation) return;
    busy = false;
    document.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
    render(status);
  } catch (error) {
    if (owner !== generation) return;
    busy = false;
    document.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
    $("status").textContent = String(error.message).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      "",
    );
  }
}
document
  .querySelectorAll("[data-permission]")
  .forEach((button) =>
    button.addEventListener("click", () => action("settings", button.dataset.permission)),
  );
$("app-tile").addEventListener("dragstart", (event) => {
  event.preventDefault();
  window.computerSetup.drag();
});
for (const [id, name] of [
  ["restart", "restart"],
  ["check", "status"],
  ["enable", "enable"],
  ["stop", "stop"],
])
  $(id).addEventListener("click", () => action(name));
void action("prepare");

void window.computerSetup
  .action("icon")
  .then((icon) => {
    $("app-icon").src = icon;
  })
  .catch(() => {});
