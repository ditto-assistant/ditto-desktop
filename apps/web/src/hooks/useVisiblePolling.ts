import { useEffect, useEffectEvent } from "react";

/** Polls only while the desktop surface is visible and refreshes immediately on return. */
export function useVisiblePolling(
  refresh: () => void,
  options: { readonly enabled: boolean; readonly intervalMs: number },
): void {
  const runRefresh = useEffectEvent(refresh);

  useEffect(() => {
    if (!options.enabled) return;
    const visible = () => document.visibilityState === "visible";
    const tick = () => {
      if (visible()) runRefresh();
    };
    const onVisibilityChange = () => {
      if (visible()) runRefresh();
    };
    const interval = window.setInterval(tick, options.intervalMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [options.enabled, options.intervalMs]);
}
