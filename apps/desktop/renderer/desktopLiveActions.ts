import { createEffect, createSignal } from "solid-js";

// Contract 3 (docs/ditto/live-mode.md): main runs web orchestrator actions in
// this window through ditto-app's own LiveActionDriver, which LiveActionBridge
// registers inside the Router. Older bundled ditto-apps have no such module;
// the glob is then empty, the build still succeeds and main falls back to
// `unsupported` with a route-only context.
interface LiveActionOutcome {
  ok: boolean;
  summary: string;
  error: string | null;
  reply: string | null;
}
interface LiveDriverLike {
  snapshot: () => {
    route: string;
    surface: string;
    activeAgentId: string | null;
    activeThreadId: string | null;
  };
}
interface LiveClientActionsModule {
  liveActionDriver: () => LiveDriverLike | null;
  parseClientAction: (
    data: unknown,
  ) =>
    | { ok: true; id: string; action: unknown }
    | { ok: false; id: string; error: string; summary: string }
    | null;
  executeLiveAction: (
    action: unknown,
    env: { driver: () => LiveDriverLike | null },
    state: { promptInFlight: boolean },
  ) => Promise<unknown>;
  actionResult: (id: string, outcome: unknown) => LiveActionOutcome & { type: string; id: string };
  buildClientContext: (
    snapshot: ReturnType<LiveDriverLike["snapshot"]>,
  ) => Record<string, unknown> & { type: string };
}
interface DesktopLiveShim {
  snapshot(): Record<string, unknown> | null;
  run(action: unknown): Promise<LiveActionOutcome | null>;
}
declare global {
  interface Window {
    __dittoDesktopLive?: DesktopLiveShim;
  }
}

const liveModules = import.meta.glob<LiveClientActionsModule>("../lib/liveClientActions.ts");

export function connectDesktopLiveActions(): () => void {
  if (typeof window === "undefined") return () => {};
  const desktop = (window as Window & { ditto?: { liveContextChanged?: () => void } }).ditto;
  const load = Object.values(liveModules)[0];
  if (!desktop || !load) return () => {};
  const [actions, setActions] = createSignal<LiveClientActionsModule | null>(null);
  const loading = load().then(
    (module) => {
      setActions(() => module);
      return module;
    },
    () => null,
  );
  // One prompt in flight at a time, across every action main forwards.
  const state = { promptInFlight: false };
  const shim: DesktopLiveShim = {
    snapshot() {
      const module = actions();
      const driver = module?.liveActionDriver();
      if (!module || !driver) return null;
      const { type: _type, ...context } = module.buildClientContext(driver.snapshot());
      return context;
    },
    async run(action) {
      const module = actions() ?? (await loading);
      if (!module) return null;
      // Main forwards the action object alone; the aura owns ids and the ledger.
      const parsed = module.parseClientAction({ id: "desktop", action });
      if (!parsed) return null;
      const outcome = parsed.ok
        ? await module
            .executeLiveAction(parsed.action, { driver: module.liveActionDriver }, state)
            .catch(() => ({
              ok: false,
              error: "send_failed",
              summary: "Something went wrong doing that.",
            }))
        : parsed;
      const { ok, summary, error, reply } = module.actionResult(parsed.id, outcome);
      return { ok, summary, error, reply };
    },
  };
  window.__dittoDesktopLive = shim;
  createEffect(() => {
    const driver = actions()?.liveActionDriver();
    if (!driver) return;
    driver.snapshot();
    desktop.liveContextChanged?.();
  });
  return () => {
    if (window.__dittoDesktopLive === shim) delete window.__dittoDesktopLive;
  };
}
