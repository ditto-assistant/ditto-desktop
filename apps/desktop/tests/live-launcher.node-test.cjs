const test = require("node:test");
const assert = require("node:assert/strict");
const { liveLauncherOverlay } = require("../scripts/desktop-live-launcher-bridge.cjs");

// Trimmed from the pinned ditto-app's SendMessage.tsx and V2Shell.tsx.
const composer = `import { Show } from "solid-js"
                            <Show when={hasAudioInput()}>
                              <DropdownMenuItem
                                onClick={startLiveMode}
                                class="v2-composer-menu-item"
                              >
                                <PhoneCall class="v2-icon" />
                                <span>Live mode</span>
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={startMeetingMode}>Meeting</DropdownMenuItem>
                            </Show>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button onClick={startLiveMode} aria-label={t(msg("Live mode"))}>
                                    <PhoneCall class="h-5 w-5" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t(msg("Live mode"))}</TooltipContent>
                              </Tooltip>
                      <Show when={!codeComposerActive()}>
                        <div class="v2-composer-temporary-slot">
                          <Tooltip>
                            <TooltipTrigger data-testid="composer-temporary-chat">
                              <V2Icon name="temporary-chat" />
                            </TooltipTrigger>
                          </Tooltip>
                        </div>
                      </Show>

                      <div class="v2-composer-send-slot">
                        <div class="v2-composer-submit-actions flex items-center gap-2">
                          <Tooltip><TooltipTrigger aria-label="Send message" /></Tooltip>
                        </div>
                      </div>
`;
const shell = `export function Header() {
  return (
    <>
      <button class="v2-studio-icon-button v2-header-search-trigger">
        <V2Icon name="search" />
      </button>
      <Show when={showWorkspaceInHeader()}>
        <Workspace />
      </Show>
    </>
  )
}
`;

test("the composer gets the Live launcher beside Send and Temporary chat moves to the header", () => {
  const out = liveLauncherOverlay({ composer, shell });
  assert.doesNotMatch(out.composer, /composer-temporary-chat|startLiveMode|PhoneCall/);
  assert.match(out.composer, /startMeetingMode/);
  assert.match(
    out.composer,
    /submit-actions flex items-center gap-2"><Show when=\{!codeComposerActive\(\) && !showSeparateStop\(\)\}><DesktopLiveLauncher [^>]*\/><\/Show>\s*<Tooltip><TooltipTrigger aria-label="Send message"/,
  );
  assert.match(
    out.composer,
    /^import DesktopLiveLauncher from "@\/desktop\/DesktopLiveLauncher"\n/,
  );
  assert.match(
    out.shell,
    /<V2Icon name="search" \/>\s*<\/button><DesktopHeaderTemporaryChat \/>\s*<Show when=\{showWorkspaceInHeader\(\)\}>/,
  );
  assert.match(out.shell, /^import DesktopHeaderTemporaryChat from /);
});

test("applying the overlay twice changes nothing more", () => {
  const once = liveLauncherOverlay({ composer, shell });
  assert.deepEqual(liveLauncherOverlay(once), once);
});

test("a missing anchor in either file leaves both files untouched", () => {
  for (const sources of [
    { composer: composer.replace("v2-composer-temporary-slot", "v2-composer-slot"), shell },
    { composer: composer.replace("v2-composer-submit-actions", "v2-composer-actions"), shell },
    { composer, shell: shell.replace('<V2Icon name="search" />', '<V2Icon name="find" />') },
  ])
    assert.deepEqual(liveLauncherOverlay(sources), sources);
});

test("a ditto-app that ships its own launcher (ditto-app#3432) is left alone", () => {
  const upstream = {
    composer: composer.replace(
      '<div class="v2-composer-submit-actions flex items-center gap-2">',
      '<div class="v2-composer-submit-actions flex items-center gap-2"><LiveModeButton placement="composer" />',
    ),
    shell,
  };
  assert.deepEqual(liveLauncherOverlay(upstream), upstream);
  const movedHeader = {
    composer,
    shell: shell.replace("</button>", '</button><button data-testid="header-temporary-chat" />'),
  };
  assert.deepEqual(liveLauncherOverlay(movedHeader), movedHeader);
});

test("the launcher follows main's live state from every entry point", async () => {
  const { followLiveActive } = await import("../renderer/liveLauncherState.ts");
  let push;
  let resolveStatus;
  const desktop = {
    liveToggle: async () => true,
    liveStatus: () => new Promise((resolve) => (resolveStatus = resolve)),
    onLiveActive: (listener) => {
      push = listener;
      return () => (push = null);
    },
  };
  const seen = [];
  const stop = followLiveActive(desktop, (active) => seen.push(active));
  // Started from the rail or Cmd+Shift+L before the initial status returned.
  push(true);
  resolveStatus({ active: false });
  await new Promise(setImmediate);
  assert.deepEqual(seen, [true]);
  push(false);
  assert.deepEqual(seen, [true, false]);
  stop();
  assert.equal(push, null);

  const quiet = [];
  let settle;
  followLiveActive(
    { ...desktop, liveStatus: () => new Promise((resolve) => (settle = resolve)) },
    (active) => quiet.push(active),
  );
  settle({ active: true });
  await new Promise(setImmediate);
  assert.deepEqual(quiet, [true]);
});

test("the shortcut hint matches the platform's Live accelerator", async () => {
  const { liveShortcut } = await import("../renderer/liveLauncherState.ts");
  assert.deepEqual(liveShortcut("MacIntel"), { keys: ["⌘", "⇧", "L"], aria: "Meta+Shift+L" });
  assert.equal(liveShortcut("Win32").aria, "Control+Shift+L");
});
