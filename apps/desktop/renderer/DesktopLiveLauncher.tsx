import { AudioLines } from "lucide-solid";
import { createSignal, onCleanup, Show } from "solid-js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { followLiveActive, liveLauncherBridge, liveShortcut } from "./liveLauncherState";
import "./desktopLiveLauncher.css";

// ditto-app#3432's composer LiveModeButton, driving the desktop aura instead
// of ditto-app's in-window session. Same markup and test id, so the styles and
// any probe written against the web launcher apply here too.
export default function DesktopLiveLauncher(props: { disabledReason?: string }) {
  const desktop = liveLauncherBridge();
  const [active, setActive] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  if (desktop) onCleanup(followLiveActive(desktop, setActive));
  const shortcut = liveShortcut(typeof navigator === "undefined" ? "" : navigator.platform);
  // aria-disabled rather than disabled, so the tooltip can still say why.
  const blocked = () => pending() || (!active() && !!props.disabledReason);
  const activate = async () => {
    if (!desktop || blocked()) return;
    setPending(true);
    try {
      setActive(await desktop.liveToggle());
    } finally {
      setPending(false);
    }
  };
  return (
    <Show when={desktop}>
      <Tooltip placement="top">
        <TooltipTrigger
          type="button"
          class="live-mode-button"
          data-testid="live-mode-launcher"
          data-placement="composer"
          data-active={active() ? "true" : undefined}
          aria-pressed={active()}
          aria-disabled={blocked() ? "true" : undefined}
          aria-label={active() ? "Stop live mode" : "Start live mode"}
          aria-keyshortcuts={shortcut.aria}
          onClick={() => void activate()}
        >
          <AudioLines class="v2-icon" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>
          <span class="inline-flex items-center gap-2">
            {!active() && props.disabledReason
              ? props.disabledReason
              : active()
                ? "Stop live mode"
                : "Talk to Ditto by voice"}
            <kbd class="live-dock-kbd" data-testid="live-mode-shortcut-hint">
              {shortcut.keys.join(" ")}
            </kbd>
          </span>
        </TooltipContent>
      </Tooltip>
    </Show>
  );
}
