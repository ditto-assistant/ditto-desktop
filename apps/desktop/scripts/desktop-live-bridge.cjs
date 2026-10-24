// One Live entry point (docs/ditto/live-mode.md, Contract 3): on desktop,
// ditto-app's `startLiveMode` in src/contexts/LiveModeContext.tsx starts the
// desktop aura session instead of opening its own realtime socket. Meeting
// mode keeps the in-app session. A ditto-app without this function is left
// untouched, so older and newer submodule pins both build.
const anchor = 'function startLiveMode(): Promise<void> {\n    return startSession("live")\n  }';

function liveModeOverlay(source) {
  if (!source.includes(anchor) || source.indexOf(anchor) !== source.lastIndexOf(anchor))
    return source;
  return source.replace(
    anchor,
    `async function startLiveMode(): Promise<void> {
    const desktop = (globalThis as typeof globalThis & { ditto?: { liveToggle?: () => Promise<unknown>; liveStatus?: () => Promise<{ active?: boolean }> } }).ditto
    if (import.meta.env.VITE_DITTO_DESKTOP && desktop?.liveToggle) {
      const status = await desktop.liveStatus?.().catch(() => null)
      if (!status?.active) await desktop.liveToggle()
      return
    }
    return startSession("live")
  }`,
  );
}

module.exports = { liveModeOverlay };
