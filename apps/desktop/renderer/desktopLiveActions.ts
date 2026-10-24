import { getOwner, runWithOwner } from "solid-js";

// Contract 3 (docs/ditto/live-mode.md): web orchestrator actions run in this
// window through ditto-app's own `createLiveClientActions`, exactly as its
// LiveModeContext uses it, so the ledger, context-before-result ordering,
// history steps and agent refetch are ditto-app's. Only the exported names
// below are used; the module's internals are still moving. Older bundled
// ditto-apps have no such module: the glob is then empty, the build still
// succeeds and main answers `unsupported` with a route-only context.
interface LiveActionResult {
  type: "client_action_result";
  id: string;
  ok: boolean;
  summary: string;
  error: string | null;
  reply: string | null;
}
type LiveContextMessage = Record<string, unknown> & { type: "client_context" };
interface LiveDriverLike {
  snapshot: () => unknown;
}
interface LiveClientActionsModule {
  liveActionDriver: () => LiveDriverLike | null;
  buildClientContext: (snapshot: never) => LiveContextMessage;
  createLiveClientActions: (options: {
    driver: () => LiveDriverLike | null;
    sessionReady: () => boolean;
    sendContext: (message: LiveContextMessage) => void;
  }) => {
    sessionStarted: () => void;
    handle: (data: unknown, reply: (result: LiveActionResult) => void) => void;
  };
}
interface DesktopLiveShim {
  /** The aura's socket started (or lost) its session. */
  setReady(ready: boolean): Promise<boolean>;
  /** One `client_action` frame; resolves with the result and the context sent right before it. */
  handle(
    frame: unknown,
  ): Promise<{ result: LiveActionResult; context: LiveContextMessage | null } | null>;
  context(): LiveContextMessage | null;
}
declare global {
  interface Window {
    __dittoDesktopLive?: DesktopLiveShim;
  }
}

const liveModules = import.meta.glob<LiveClientActionsModule>("../lib/liveClientActions.ts");
// Under the server's 90 s prompt wait; a resent id that is still running gets
// no second reply from ditto-app, so this bounds the main-process call.
const HANDLE_TIMEOUT_MS = 88_000;

export function connectDesktopLiveActions(): () => void {
  if (typeof window === "undefined") return () => {};
  const desktop = (
    window as Window & { ditto?: { liveClientContext?: (message: unknown) => void } }
  ).ditto;
  const load = Object.values(liveModules)[0];
  if (!desktop?.liveClientContext || !load) return () => {};
  const push = desktop.liveClientContext;
  // createLiveClientActions sets up effects, so it needs this component's owner.
  const owner = getOwner();
  let ready = false;
  let claimed = "";
  const loading = load().then(
    (module) => {
      const actions = runWithOwner(owner, () =>
        module.createLiveClientActions({
          driver: module.liveActionDriver,
          sessionReady: () => ready,
          // Debounced and session-start contexts go to the aura on their own.
          // The one ditto-app sends right before a result travels with that
          // result instead, so the aura can keep the order on its socket.
          sendContext: (message) => {
            const serialized = JSON.stringify(message);
            queueMicrotask(() => {
              if (serialized !== claimed) push(message);
              claimed = "";
            });
          },
        }),
      );
      return actions ? { module, actions } : null;
    },
    () => null,
  );
  const context = (module: LiveClientActionsModule): LiveContextMessage | null => {
    const driver = module.liveActionDriver();
    return driver ? module.buildClientContext(driver.snapshot() as never) : null;
  };
  let current: LiveClientActionsModule | null = null;
  void loading.then((loaded) => {
    current = loaded?.module ?? null;
  });

  const shim: DesktopLiveShim = {
    async setReady(value) {
      const loaded = await loading;
      ready = value;
      if (value) loaded?.actions.sessionStarted();
      return Boolean(loaded);
    },
    async handle(frame) {
      const loaded = await loading;
      if (!loaded) return null;
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), HANDLE_TIMEOUT_MS);
        loaded.actions.handle(frame, (result) => {
          clearTimeout(timer);
          const sent = context(loaded.module);
          // ditto-app's pre-result send ran synchronously just before this
          // reply; its microtask (queued first) sees the claim and skips.
          claimed = sent ? JSON.stringify(sent) : "";
          queueMicrotask(() => {
            claimed = "";
          });
          resolve({ result, context: sent });
        });
      });
    },
    context: () => (current ? context(current) : null),
  };
  window.__dittoDesktopLive = shim;
  return () => {
    ready = false;
    if (window.__dittoDesktopLive === shim) delete window.__dittoDesktopLive;
  };
}
