const os = require("node:os");
const { execFile } = require("node:child_process");

// Main-process side of the aura's `window.dittoLive` (docs/ditto/live-mode.md,
// Contract 2). Wiring from main.cjs, after app ready:
//   const live = registerLiveBridge({ ipcMain, computer, getMainWindow: () => win,
//     getAuraWindow, getSession, emit });
//   live.onStop((reason) => closeAura()); live.startSession() once the aura loads;
//   live.stopSession(reason) for the shortcut; live.dispose() on quit.
// `ditto-live:command` goes straight to the aura's webContents; `emit` is
// main.cjs's main-window emitter and receives `ditto:live-state`.
// The aura preload uses ipcRenderer.invoke for session/capture/frontmost/tool
// and may use send or invoke for state/interactive/stop. Only the aura's
// webContents is accepted. Disabling Computer Use stops Live by itself.
// `ditto_client_action` and `ditto_client_context` (Contract 3) run in the
// main Ditto window through renderer/desktopLive.ts's `window.__dittoDesktopLive`,
// which wraps ditto-app's LiveActionDriver when the bundled app has one.
const INVOKE = ["session", "capture", "frontmost", "tool"];
const SEND = ["state", "interactive", "stop"];
const STATES = new Set([
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "acting",
  "error",
  "idle",
]);
const MODIFIERS = {
  cmd: "cmd",
  command: "cmd",
  shift: "shift",
  option: "option",
  alt: "option",
  ctrl: "ctrl",
  control: "ctrl",
  fn: "fn",
};
const ROUTES = { home: "/", chat: "/", chats: "/", code: "/code" };
const FRONTMOST_TTL = 250;
const NO_DRIVER = {
  ok: false,
  error: "unsupported",
  summary: "This version of Ditto can't do that yet. Use ditto_app or the screen instead.",
};
const TITLE_TTL = 1000;

class LiveToolError extends Error {}

function execText(file, args) {
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 2000, maxBuffer: 64 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    ),
  );
}

function usable(window) {
  return window && !window.isDestroyed() ? window : null;
}

function contains(bounds, point) {
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x < bounds.x + bounds.width &&
    point.y < bounds.y + bounds.height
  );
}

// Tool coordinates are 0-1000 over the display in the latest frame. Electron
// screen bounds are global points with the primary display's top-left at 0,0,
// the same space CoreGraphics uses for event posting.
function toScreenPoint(display, x, y) {
  if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1000))
    throw new LiveToolError("Use x and y from 0 to 1000 on the latest screen frame.");
  const { bounds } = display;
  return {
    x: Math.min(bounds.x + Math.round((x / 1000) * bounds.width), bounds.x + bounds.width - 1),
    y: Math.min(bounds.y + Math.round((y / 1000) * bounds.height), bounds.y + bounds.height - 1),
  };
}

// cmux `click` with scope "desktop" takes pixels of its main-display screenshot
// and divides by screenshot width / screen width. That ratio is not always the
// backing scale (a 1728pt Retina panel has produced 3592px shots), so use the
// one the latest get_desktop_state reported. Other displays are negative or
// beyond its width in the same global space.
function desktopRatio(observation, fallback) {
  const shot = observation?.screenshot_width;
  const width = observation?.screen_width;
  return shot > 0 && width > 0 ? Math.max(1, shot / width) : fallback;
}

function toDesktopPixels(ratio, point) {
  return { x: point.x * ratio, y: point.y * ratio };
}

// cmux scroll and drag address a window in its own screenshot pixels. They run
// in foreground mode: macOS has no background drag and Electron windows reject
// background scroll, and Live acts visibly like a desktop click anyway.
function toWindowPixels(window, scaleFactor, point) {
  return {
    x: (point.x - window.bounds.x) * scaleFactor,
    y: (point.y - window.bounds.y) * scaleFactor,
  };
}

function parseFrontApp(text) {
  const field = (key) => text.match(new RegExp(`"${key}"="?([^"\\n]*)"?`))?.[1];
  const pid = Number(field("pid"));
  return {
    app: field("LSDisplayName") ?? "",
    bundleId: field("CFBundleIdentifier") || undefined,
    pid: Number.isInteger(pid) ? pid : undefined,
  };
}

function resultText(result) {
  return (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .slice(0, 4000);
}

function navigateScript(route) {
  // Prefer the app's own rail links so the router handles the transition.
  return `(() => {
    const route = ${JSON.stringify(route)};
    const label = route.label && route.label.toLowerCase();
    const link = [...document.querySelectorAll("nav.v2-studio-rail a, a[href]")].find((item) =>
      label ? (item.getAttribute("aria-label") || "").toLowerCase() === label
        : item.getAttribute("href") === route.path);
    if (link) link.click();
    else if (route.path && location.pathname + location.search !== route.path) {
      history.pushState(null, "", route.path);
      dispatchEvent(new PopStateEvent("popstate", { state: null }));
    } else if (!route.path) return null;
    return location.pathname;
  })()`;
}

const NEW_CHAT_SCRIPT = `(() => {
  const button = [...document.querySelectorAll("button.v2-studio-create:not(.ditto-code-new)")]
    .find((item) => !item.hidden && item.getClientRects().length);
  if (!button) return false;
  button.click();
  return true;
})()`;

// Routes the prompt through the Code tab's own composer path
// (desktop-shell.js dittoDesktopStartCode), so the run is visible and uses the
// same Ditto Code engine, workspace and cancel button as a typed task.
function askCodeScript(prompt) {
  return `(async () => {
    const prompt = ${JSON.stringify(prompt)};
    if (location.pathname !== "/code") {
      history.pushState(null, "", "/code");
      dispatchEvent(new PopStateEvent("popstate", { state: null }));
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const started = await window.dittoDesktopStartCode?.({ prompt });
      if (started) return started;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { status: "unavailable", reason: "The Ditto Code panel did not open." };
  })()`;
}

function clientActionScript(action) {
  return `(async () => {
    const live = window.__dittoDesktopLive;
    return live ? await live.run(${JSON.stringify(action)}) : null;
  })()`;
}

const CLIENT_CONTEXT_SCRIPT = `(() => window.__dittoDesktopLive?.snapshot() ?? null)()`;

function urlRoute(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return "/";
  }
}

function routeFor(target) {
  if (typeof target !== "string" || !target.trim())
    throw new LiveToolError("Say where to go in Ditto, such as chats, code or a /path.");
  const value = target.trim();
  const alias = ROUTES[value.toLowerCase()];
  if (alias) return { path: alias };
  if (/^\/[\w\-/.?=&%]{0,200}$/.test(value)) return { path: value };
  if (/^[\w ]{1,40}$/.test(value)) return { label: value };
  throw new LiveToolError("Use a Ditto section name or a path that starts with /.");
}

function registerLiveBridge({
  ipcMain,
  computer,
  getMainWindow,
  getAuraWindow,
  getSession,
  emit,
  // Test seams; Electron and macOS by default.
  electron = require("electron"),
  run = execText,
  platform = os.platform(),
  pid = process.pid,
}) {
  const { BrowserWindow, desktopCapturer, screen, app } = electron;
  const stopListeners = new Set();
  let active = false;
  let disposed = false;
  let session = null;
  let needsObserve = true;
  let observation = null;
  let pending = 0;
  let toolTail = Promise.resolve();
  let liveState = "idle";
  let display = null;
  let frontCache = null;
  let titles = { at: 0, byPid: new Map(), refreshing: false };

  const aura = () => usable(getAuraWindow?.());
  const send = (command) => aura()?.webContents.send("ditto-live:command", command);
  const setState = (state) => {
    if (state === liveState) return;
    liveState = state;
    emit?.("ditto:live-state", state);
  };

  // Only the aura renderer may drive the live bridge.
  const fromAura = (event) => {
    const window = aura();
    return Boolean(window && event?.sender === window.webContents);
  };

  function currentDisplay() {
    if (display) {
      const latest = screen.getAllDisplays().find((item) => item.id === display.id);
      if (latest) return latest;
    }
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  async function capture(options = {}) {
    const target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { bounds, scaleFactor } = target;
    const maxWidth = Number.isFinite(options.maxWidth)
      ? Math.max(160, Math.min(3840, Math.round(options.maxWidth)))
      : 1280;
    const quality = Number.isFinite(options.quality)
      ? Math.max(0.1, Math.min(1, options.quality))
      : 0.6;
    const width = Math.min(maxWidth, Math.round(bounds.width * scaleFactor));
    const height = Math.round((width * bounds.height) / bounds.width);
    // Content protection keeps the aura out of captures; fall back to hiding it
    // for this one capture when the shell could not protect it.
    const window = aura();
    const hide = window?.isContentProtected?.() === false && window.isVisible();
    const opacity = hide ? window.getOpacity() : 1;
    if (hide) window.setOpacity(0);
    let sources;
    try {
      sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
      });
    } finally {
      if (hide && !window.isDestroyed()) window.setOpacity(opacity);
    }
    const source =
      sources.find((item) => item.display_id === String(target.id)) ??
      (sources.length === 1 ? sources[0] : null);
    if (!source || source.thumbnail.isEmpty())
      throw new Error("Allow Screen Recording for Ditto Desktop to share your screen with Live.");
    const size = source.thumbnail.getSize();
    display = target;
    return {
      data: source.thumbnail.toJPEG(Math.round(quality * 100)).toString("base64"),
      mimeType: "image/jpeg",
      width: size.width,
      height: size.height,
      display: { ...bounds, scaleFactor },
    };
  }

  async function frontApp() {
    if (platform !== "darwin") return { app: "", pid: undefined };
    if (frontCache && Date.now() - frontCache.at < FRONTMOST_TTL) return frontCache.value;
    if (frontCache?.loading) return frontCache.loading;
    const loading = (async () => {
      const asn = (await run("/usr/bin/lsappinfo", ["front"])).trim();
      if (!/^ASN:[\w-]+:?$/.test(asn)) return { app: "", pid: undefined };
      return parseFrontApp(
        await run("/usr/bin/lsappinfo", [
          "info",
          "-only",
          "name",
          "-only",
          "bundleid",
          "-only",
          "pid",
          asn,
        ]),
      );
    })();
    frontCache = { at: 0, loading };
    try {
      const value = await loading;
      frontCache = { at: Date.now(), value };
      return value;
    } catch (error) {
      frontCache = null;
      throw error;
    }
  }

  // Window titles need Accessibility, so they come from the cmux session when
  // it is open and idle; frontmost polling must never queue behind actions.
  function refreshTitles() {
    if (!session || pending || titles.refreshing || Date.now() - titles.at < TITLE_TTL) return;
    titles.refreshing = true;
    session
      .then((open) => open.call("computer_list_windows", { on_screen_only: true }))
      .then((result) => {
        const byPid = new Map();
        const windows = (result?.structuredContent?.windows ?? [])
          .filter((window) => window.layer === 0 || window.layer === undefined)
          .sort((a, b) => (a.z_index ?? 0) - (b.z_index ?? 0));
        for (const window of windows) if (window.title) byPid.set(window.pid, window.title);
        titles = { at: Date.now(), byPid, refreshing: false };
      })
      .catch(() => {
        titles = { ...titles, at: Date.now(), refreshing: false };
      });
  }

  async function frontmost() {
    const focused = usable(BrowserWindow.getFocusedWindow());
    if (focused && focused.id !== aura()?.id)
      return { app: app.getName(), title: focused.getTitle(), isDitto: true };
    const front = await frontApp();
    refreshTitles();
    const title = front.pid === undefined ? undefined : titles.byPid.get(front.pid);
    return {
      app: front.app,
      ...(front.bundleId ? { bundleId: front.bundleId } : {}),
      ...(title ? { title } : {}),
      isDitto: front.pid === pid,
    };
  }

  function openSession() {
    if (!active) throw new LiveToolError("Live mode is not running.");
    if (!computer.enabled) throw new LiveToolError("Turn on Computer Use in Ditto Desktop first.");
    if (!session) {
      needsObserve = true;
      const opening = computer.createSession().then((open) => {
        if (!active || session !== opening) {
          open.close();
          throw new LiveToolError("Live mode is not running.");
        }
        return open;
      });
      session = opening;
      opening.catch(() => {
        if (session === opening) session = null;
      });
    }
    return session;
  }

  function closeSession() {
    const closing = session;
    session = null;
    needsObserve = true;
    titles = { at: 0, byPid: new Map(), refreshing: false };
    closing?.then((open) => open.close()).catch(() => {});
  }

  async function call(name, args) {
    const open = await openSession();
    try {
      const result = await open.call(name, args);
      if (result?.isError) throw new LiveToolError(resultText(result) || "Computer Use failed.");
      return result;
    } catch (error) {
      if (/session has ended/.test(error.message)) {
        if (session) closeSession();
        if (!computer.enabled) stopSession("computer-use-disabled");
      }
      throw error;
    }
  }

  // ComputerService refuses input after an action with an unverifiable outcome
  // (every desktop-scope click) until a desktop screenshot is observed. Observe
  // lazily before the next action, never by retrying the action itself.
  async function act(name, args) {
    if (needsObserve) {
      observation = (await call("computer_get_desktop_state", {})).structuredContent;
      needsObserve = false;
    }
    needsObserve = true;
    return resultText(await call(name, typeof args === "function" ? args() : args));
  }

  function screenPoint(x, y) {
    const point = toScreenPoint(currentDisplay(), x, y);
    const window = aura();
    if (window?.isVisible() && contains(window.getBounds(), point))
      throw new LiveToolError(
        "That point is on the Ditto aura. Choose a point in the app below it.",
      );
    return point;
  }

  async function windowAt(point) {
    const windows = (await call("computer_list_windows", { on_screen_only: true }))
      .structuredContent?.windows;
    const auraBounds = aura()?.getBounds();
    const target = (windows ?? [])
      .filter(
        (window) =>
          (window.layer === 0 || window.layer === undefined) &&
          window.bounds &&
          contains(window.bounds, point) &&
          !(
            window.pid === pid &&
            auraBounds &&
            ["x", "y", "width", "height"].every((key) => window.bounds[key] === auraBounds[key])
          ),
      )
      .sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0))[0];
    if (!target) throw new LiveToolError("No app window is at that point.");
    const scaleFactor = screen.getDisplayMatching(target.bounds).scaleFactor;
    return { target, pixels: (at) => toWindowPixels(target, scaleFactor, at) };
  }

  async function frontPid() {
    const front = await frontApp();
    if (front.pid === undefined) throw new LiveToolError("No app is in front to receive input.");
    return front.pid;
  }

  async function dittoApp({ action, target, prompt } = {}) {
    const window = usable(getMainWindow?.());
    if (!window) throw new LiveToolError("The Ditto window is not open.");
    const script = (source) => window.webContents.executeJavaScript(source, true);
    switch (action) {
      case "show":
      case "focus":
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        app.focus?.({ steal: true });
        needsObserve = true;
        frontCache = null;
        return "Ditto is in front.";
      case "hide":
        window.hide();
        needsObserve = true;
        frontCache = null;
        return "Ditto is hidden.";
      case "navigate": {
        const route = routeFor(target);
        const path = await script(navigateScript(route));
        if (path === null) throw new LiveToolError(`Ditto has no ${route.label} section.`);
        return `Ditto is showing ${path}.`;
      }
      case "new_chat":
        if (!(await script(NEW_CHAT_SCRIPT)))
          throw new LiveToolError("Ditto's New chat button is not available right now.");
        return "Started a new chat in Ditto.";
      case "ask_code": {
        const text = typeof prompt === "string" && prompt.trim() ? prompt : target;
        if (typeof text !== "string" || !text.trim() || text.length > 12000)
          throw new LiveToolError("Give Ditto Code a task under 12,000 characters.");
        const started = await script(askCodeScript(text.trim()));
        if (started?.status !== "started")
          throw new LiveToolError(started?.reason || "Ditto Code could not start the task.");
        return "Ditto Code started the task in the Code tab.";
      }
      default:
        throw new LiveToolError("Use show, hide, navigate, new_chat or ask_code.");
    }
  }

  // Main never interprets an action beyond set_live_view: the Ditto window's
  // own executor owns the contract's outcomes and error codes.
  async function clientAction(action) {
    if (!action || typeof action !== "object" || typeof action.kind !== "string") return NO_DRIVER;
    if (action.kind === "set_live_view") {
      if (action.view !== "expanded") return { ok: true, summary: "Live stays in the aura." };
      await dittoApp({ action: "show" });
      return { ok: true, summary: "Ditto is in front." };
    }
    const window = usable(getMainWindow?.());
    if (!window) throw new LiveToolError("The Ditto window is not open.");
    const outcome = await window.webContents.executeJavaScript(clientActionScript(action), true);
    return outcome && typeof outcome === "object" && typeof outcome.ok === "boolean"
      ? outcome
      : NO_DRIVER;
  }

  // Without a driver the server still learns where the Ditto window is.
  async function clientContext() {
    const window = usable(getMainWindow?.());
    if (!window) throw new LiveToolError("The Ditto window is not open.");
    const snapshot = await window.webContents
      .executeJavaScript(CLIENT_CONTEXT_SCRIPT, true)
      .catch(() => null);
    if (snapshot && typeof snapshot === "object" && typeof snapshot.route === "string")
      return snapshot;
    return {
      route: urlRoute(window.webContents.getURL()),
      surface: "",
      activeAgentId: null,
      activeThreadId: null,
      destinations: [],
    };
  }

  async function runTool(name, args) {
    const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    switch (name) {
      case "computer_click": {
        const point = screenPoint(input.x, input.y);
        const button = input.button === "right" ? "right" : "left";
        return act("computer_click", () => ({
          ...toDesktopPixels(
            desktopRatio(observation, screen.getPrimaryDisplay().scaleFactor),
            point,
          ),
          scope: "desktop",
          button,
          ...(input.double === true ? { count: 2 } : {}),
        }));
      }
      case "computer_type_text":
        if (typeof input.text !== "string" || !input.text || input.text.length > 10000)
          throw new LiveToolError("Type text under 10,000 characters.");
        return act("computer_type_text", { pid: await frontPid(), text: input.text });
      case "computer_press_key": {
        if (typeof input.key !== "string" || !/^[\w+\-=[\];',./`\\ ]{1,24}$/.test(input.key))
          throw new LiveToolError("Use a key name such as return, tab, escape or a.");
        const modifiers = (Array.isArray(input.modifiers) ? input.modifiers : []).map((item) => {
          const modifier = MODIFIERS[String(item).toLowerCase()];
          if (!modifier) throw new LiveToolError("Use modifiers cmd, shift, option, ctrl or fn.");
          return modifier;
        });
        return act("computer_press_key", {
          pid: await frontPid(),
          key: input.key.toLowerCase(),
          ...(modifiers.length ? { modifiers } : {}),
        });
      }
      case "computer_scroll": {
        if (!["up", "down", "left", "right"].includes(input.direction))
          throw new LiveToolError("Scroll up, down, left or right.");
        const point = screenPoint(input.x, input.y);
        const { target, pixels } = await windowAt(point);
        const amount = Number.isInteger(input.amount) ? Math.max(1, Math.min(input.amount, 20)) : 3;
        return act("computer_scroll", {
          pid: target.pid,
          window_id: target.window_id,
          direction: input.direction,
          amount,
          ...pixels(point),
          delivery_mode: "foreground",
        });
      }
      case "computer_drag": {
        const from = screenPoint(input.from_x, input.from_y);
        const to = screenPoint(input.to_x, input.to_y);
        const { target, pixels } = await windowAt(from);
        const start = pixels(from);
        const end = pixels(to);
        return act("computer_drag", {
          pid: target.pid,
          window_id: target.window_id,
          from_x: start.x,
          from_y: start.y,
          to_x: end.x,
          to_y: end.y,
          delivery_mode: "foreground",
        });
      }
      case "computer_open_app":
        if (typeof input.name !== "string" || !/^[\w .&'()+-]{1,80}$/.test(input.name))
          throw new LiveToolError("Name the app to open.");
        frontCache = null;
        return act("computer_launch_app", { name: input.name });
      case "computer_get_state": {
        const target = currentDisplay();
        return {
          frontmost: await frontmost(),
          screen: { ...target.bounds, scaleFactor: target.scaleFactor },
          displays: screen.getAllDisplays().length,
          refreshFrame: true,
        };
      }
      case "ditto_app":
        return dittoApp(input);
      default:
        throw new LiveToolError("Unsupported live tool.");
    }
  }

  function tool(name, args) {
    // Ditto-window work never touches the shared mouse and keyboard, and a
    // prompt_agent may wait 75 s on a reply, so it skips the computer queue.
    const direct = { ditto_client_action: clientAction, ditto_client_context: clientContext }[name];
    if (direct)
      return direct(args).then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    pending += 1;
    const running = toolTail.then(async () => {
      try {
        return { ok: true, result: await runTool(name, args) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        pending -= 1;
      }
    });
    toolTail = running;
    return running;
  }

  // Route changes in the Ditto window, and agent changes its shim reports,
  // tell the aura to resend client_context (it debounces).
  let watched = null;
  const contextChanged = () => {
    if (active) send({ type: "context_changed" });
  };
  function watchMainWindow() {
    unwatchMainWindow();
    const window = usable(getMainWindow?.());
    if (!window) return;
    window.webContents.on("did-navigate-in-page", contextChanged);
    window.webContents.on("did-navigate", contextChanged);
    watched = window;
  }
  function unwatchMainWindow() {
    if (watched && !watched.isDestroyed()) {
      watched.webContents.removeListener("did-navigate-in-page", contextChanged);
      watched.webContents.removeListener("did-navigate", contextChanged);
    }
    watched = null;
  }
  const onContextChanged = (event) => {
    if (event?.sender === usable(getMainWindow?.())?.webContents) contextChanged();
  };
  ipcMain.on("ditto-live:context-changed", onContextChanged);

  function startSession() {
    if (disposed) throw new Error("Live mode was shut down.");
    active = true;
    watchMainWindow();
    setState("connecting");
    display = null;
    send({ type: "start" });
  }

  function stopSession(reason = "stopped") {
    if (!active) return;
    active = false;
    setState("idle");
    display = null;
    unwatchMainWindow();
    closeSession();
    send({ type: "stop" });
    for (const listener of stopListeners) {
      try {
        listener(reason);
      } catch {}
    }
  }

  const handlers = {
    session: () => getSession(),
    capture: (_event, options) => capture(options && typeof options === "object" ? options : {}),
    frontmost: () => frontmost(),
    tool: (_event, name, args) => tool(name, args),
    state: (_event, state) => {
      if (active && STATES.has(state)) setState(state);
    },
    interactive: (_event, interactive) => {
      aura()?.setIgnoreMouseEvents(interactive !== true, { forward: true });
    },
    stop: (_event, reason) =>
      stopSession(typeof reason === "string" ? reason.slice(0, 80) : "user"),
  };
  const guarded =
    (key) =>
    (event, ...args) => {
      if (!fromAura(event)) throw new Error("Live mode is only available in the Ditto aura.");
      return handlers[key](event, ...args);
    };
  for (const key of INVOKE) ipcMain.handle(`ditto-live:${key}`, guarded(key));
  // Accept both send and invoke for void calls so either preload style works.
  const listeners = SEND.map((key) => {
    const listener = (event, ...args) => {
      try {
        guarded(key)(event, ...args);
      } catch {}
    };
    ipcMain.on(`ditto-live:${key}`, listener);
    ipcMain.handle(`ditto-live:${key}`, guarded(key));
    return [key, listener];
  });

  // Disabling Computer Use must end Live too. ComputerService has a single
  // onChange hook owned by main.cjs, so chain onto it and restore on dispose.
  const previousOnChange = computer.onChange;
  const onChange = (status) => {
    previousOnChange?.call(computer, status);
    if (!status.enabled) stopSession("computer-use-disabled");
  };
  computer.onChange = onChange;

  return {
    startSession,
    stopSession,
    onStop(listener) {
      stopListeners.add(listener);
      return () => stopListeners.delete(listener);
    },
    get active() {
      return active;
    },
    get state() {
      return liveState;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopSession("disposed");
      for (const key of [...INVOKE, ...SEND]) ipcMain.removeHandler(`ditto-live:${key}`);
      for (const [key, listener] of listeners)
        ipcMain.removeListener(`ditto-live:${key}`, listener);
      ipcMain.removeListener("ditto-live:context-changed", onContextChanged);
      if (computer.onChange === onChange) computer.onChange = previousOnChange;
      stopListeners.clear();
    },
  };
}

module.exports = {
  registerLiveBridge,
  toScreenPoint,
  toDesktopPixels,
  desktopRatio,
  parseFrontApp,
};
