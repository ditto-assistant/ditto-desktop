export interface LiveLauncherBridge {
  liveToggle(): Promise<boolean>;
  liveStatus?(): Promise<{ active?: boolean }>;
  onLiveActive?(listener: (active: boolean) => void): () => void;
}

export function liveLauncherBridge(): LiveLauncherBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const desktop = (window as Window & { ditto?: Partial<LiveLauncherBridge> }).ditto;
  return desktop?.liveToggle ? (desktop as LiveLauncherBridge) : undefined;
}

// Main pushes `ditto:live-active` on every transition, whichever entry point
// (rail, Cmd+Shift+L, menu, this launcher) caused it. The initial status read
// can resolve after a push; a push is newer, so a late status never overrides it.
export function followLiveActive(
  desktop: LiveLauncherBridge,
  set: (active: boolean) => void,
): () => void {
  let pushed = false;
  let disposed = false;
  const unsubscribe =
    desktop.onLiveActive?.((active) => {
      pushed = true;
      if (!disposed) set(active);
    }) ?? (() => {});
  desktop.liveStatus?.().then(
    (status) => {
      if (!pushed && !disposed) set(!!status?.active);
    },
    () => {},
  );
  return () => {
    disposed = true;
    unsubscribe();
  };
}

export function liveShortcut(platform: string): { keys: string[]; aria: string } {
  return /mac/i.test(platform)
    ? { keys: ["⌘", "⇧", "L"], aria: "Meta+Shift+L" }
    : { keys: ["Ctrl", "Shift", "L"], aria: "Control+Shift+L" };
}
