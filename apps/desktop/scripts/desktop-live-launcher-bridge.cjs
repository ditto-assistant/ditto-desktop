// ditto-app#3432's layout on older bundled ditto-apps: the composer's slot
// beside Send holds the Live launcher (DesktopLiveLauncher, driving the desktop
// aura) and Temporary chat moves to the header. A ditto-app that already ships
// the launcher is left alone, since desktop-live-bridge.cjs routes its
// `startLiveMode` to the aura. The composer and header change together or not
// at all, so Temporary chat is never left without its entry point.
const temporarySlot =
  /\n[ \t]*<Show when=\{!code(?:Composer|Chrome)Active\(\)\}>\s*<div class="v2-composer-temporary-slot">[\s\S]*?<\/div>\s*<\/Show>\n/g;
const submitActions = '<div class="v2-composer-submit-actions flex items-center gap-2">';
const headerSearch =
  /(<V2Icon name="search" \/>\s*<\/button>)(\s*<Show when=\{showWorkspaceInHeader\(\)\}>)/g;
// Each Live mode entry the launcher replaces, by the element that wraps it.
const liveEntries = [
  ["<DropdownMenuItem", "</DropdownMenuItem>"],
  ["<Tooltip>", "</Tooltip>"],
];

function single(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function removeLiveEntries(source) {
  for (;;) {
    const at = source.indexOf("onClick={startLiveMode}");
    if (at < 0) return source;
    const wrapper = liveEntries
      .map(([open, close]) => [source.lastIndexOf(open, at), close])
      .sort(([a], [b]) => b - a)[0];
    const [start, close] = wrapper;
    const end = source.indexOf(close, at);
    if (start < 0 || end < 0) return source;
    source = source.slice(0, start) + source.slice(end + close.length);
  }
}

function liveLauncherOverlay({ composer, shell }) {
  const unchanged = { composer, shell };
  if (composer.includes("live-mode-launcher") || composer.includes("LiveModeButton"))
    return unchanged;
  if (shell.includes("header-temporary-chat")) return unchanged;
  const slot = single(composer, temporarySlot);
  const search = single(shell, headerSearch);
  if (!slot || !search || composer.split(submitActions).length !== 2) return unchanged;
  const codeActive = slot[0].includes("codeChromeActive")
    ? "codeChromeActive"
    : "codeComposerActive";
  composer =
    'import DesktopLiveLauncher from "@/desktop/DesktopLiveLauncher"\n' +
    removeLiveEntries(composer.replace(slot[0], "\n")).replace(
      submitActions,
      `${submitActions}<Show when={!${codeActive}() && !showSeparateStop()}><DesktopLiveLauncher disabledReason={isUploading() ? "Uploading files..." : undefined} /></Show>`,
    );
  shell =
    'import DesktopHeaderTemporaryChat from "@/desktop/DesktopHeaderTemporaryChat"\n' +
    shell.replace(search[0], `${search[1]}<DesktopHeaderTemporaryChat />${search[2]}`);
  return { composer, shell };
}

module.exports = { liveLauncherOverlay };
