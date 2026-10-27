// One Live Mode session in the aura window: realtime socket, mic and playback,
// screen frames, frontmost context and client tool calls. DOM-free; the audio
// engine, WebSocket and timers are injected so node tests drive it directly.

import { createClientActions } from "./actions.js";
import { createFrontmostWatcher } from "./context.js";
import { createFrameScheduler } from "./frames.js";
import {
  audioMessage,
  buildWsUrl,
  clientToolResultMessage,
  contextMessage,
  imageMessage,
  isFatalServerError,
  parseServerMessage,
  stopSessionMessage,
} from "./protocol.js";
import { createToolRunner } from "./tools.js";

const OPEN = 1;
const RECONNECT_DELAY_MS = 750;
const STOP_ACK_MS = 1000;
const SPEAKING_TAIL_MS = 300;
const ERROR_FLASH_MS = 2000;
// The model may answer a tool or a question with silence; don't spin forever.
const THINKING_MAX_MS = 8000;
const POST_ACTION_FRAME_MS = 1500;
// A frame is ~100-400 KB; on a slow uplink unsent frames would pile up in the
// socket buffer without bound, so a tick is skipped while one is still queued.
const MAX_BUFFERED_BYTES = 512 * 1024;
const CAPTURE_OPTIONS = { maxWidth: 1280 };

export function createLiveSession({
  live,
  audio,
  WebSocket: Socket = globalThis.WebSocket,
  onState = () => {},
  onMuted = () => {},
  log = () => {},
  timers = globalThis,
  frameIntervalMs,
  idlePauseMs,
}) {
  let state = "idle";
  let active = false;
  let stopping = false;
  let established = false;
  let reconnectUsed = false;
  let resumeToken = "";
  let muted = false;
  let config = null;
  let ws = null;
  let speakingTimer = null;
  let errorTimer = null;
  let thinkingTimer = null;
  let reconnectTimer = null;
  // Context notes are the only thing worth replaying after a reconnect; stale
  // audio and frames are not, and tool results belong to the old connection.
  let pendingContext = null;
  let runner = null;
  let connectionGeneration = 0;

  function record(entry) {
    try {
      live.diagnostic?.({ ...entry, generation: connectionGeneration });
    } catch {
      // Diagnostics cannot prevent normal call handling.
    }
  }

  function setState(next) {
    if (errorTimer && next !== "error") {
      timers.clearTimeout(errorTimer);
      errorTimer = null;
    }
    if (state === next) return;
    if (thinkingTimer) {
      timers.clearTimeout(thinkingTimer);
      thinkingTimer = null;
    }
    if (next === "thinking") {
      thinkingTimer = timers.setTimeout(() => {
        thinkingTimer = null;
        if (state === "thinking") settle();
      }, THINKING_MAX_MS);
    }
    state = next;
    record({ event: "state", state: next });
    onState(next);
    live.setState(next);
  }

  // After an action or server work the model is busy until it speaks again.
  function settle() {
    if (!active || stopping) return;
    if (runner?.isBusy()) setState("acting");
    else if (audio.playbackRemainingMs() > 0) setState("speaking");
    else setState("listening");
  }

  const isOpen = () => ws !== null && ws.readyState === OPEN && established;

  function send(message) {
    if (!isOpen()) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  const frames = createFrameScheduler({
    capture: () => live.captureScreen(CAPTURE_OPTIONS),
    send: (frame) => {
      if (ws && ws.bufferedAmount > MAX_BUFFERED_BYTES) return;
      send(imageMessage(frame.data, frame.mimeType));
    },
    onError: (error) => log("frame capture failed", error),
    intervalMs: frameIntervalMs,
    idlePauseMs,
    setInterval: (fn, ms) => timers.setInterval(fn, ms),
    clearInterval: (id) => timers.clearInterval(id),
  });

  const watcher = createFrontmostWatcher({
    frontmost: () => live.frontmost(),
    onChange: (text) => {
      if (!send(contextMessage(text))) pendingContext = text;
    },
    setInterval: (fn, ms) => timers.setInterval(fn, ms),
    clearInterval: (id) => timers.clearInterval(id),
  });

  function createRunner(socket) {
    const nextRunner = createToolRunner({
      tool: (name, args) => live.tool(name, args),
      respond: (id, outcome) => replyOn(socket)(clientToolResultMessage(id, outcome)),
      afterAction: () => {
        if (ws !== socket || !isOpen()) return;
        return new Promise((resolve) => {
          const timer = timers.setTimeout(resolve, POST_ACTION_FRAME_MS);
          void frames.captureNow().then(() => {
            timers.clearTimeout(timer);
            resolve();
          });
        });
      },
      onBusyChange: (busy) => {
        if (runner !== nextRunner) return;
        frames.noteActivity();
        if (busy) setState("acting");
        else if (active && !stopping) setState("thinking");
      },
      setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
      clearTimeout: (id) => timers.clearTimeout(id),
    });
    return nextRunner;
  }

  const actions = createClientActions({
    tool: (name, args) => live.tool(name, args),
    sendContext: (message) => send(message),
    log,
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: (id) => timers.clearTimeout(id),
  });

  // Results only travel on the socket that delivered the action; after a
  // reconnect the server has already resolved it as a timeout.
  function replyOn(socket) {
    return (result) => {
      if (ws !== socket || !isOpen() || !send(result)) log("action result dropped", result.id);
    };
  }

  function scheduleSpeakingEnd() {
    if (speakingTimer) timers.clearTimeout(speakingTimer);
    speakingTimer = timers.setTimeout(() => {
      speakingTimer = null;
      if (state !== "speaking") return;
      if (audio.playbackRemainingMs() > 0) scheduleSpeakingEnd();
      else settle();
    }, audio.playbackRemainingMs() + SPEAKING_TAIL_MS);
  }

  function flashError() {
    if (stopping) return;
    setState("error");
    errorTimer = timers.setTimeout(() => {
      errorTimer = null;
      settle();
    }, ERROR_FLASH_MS);
  }

  function handle(message) {
    switch (message.type) {
      case "session_started":
        established = true;
        reconnectUsed = false;
        if (message.resumeToken) resumeToken = message.resumeToken;
        if (pendingContext) {
          const text = pendingContext;
          pendingContext = null;
          send(contextMessage(text));
        }
        frames.start();
        void watcher.start();
        actions.sessionStarted();
        settle();
        break;
      case "session_resumption_ready":
        resumeToken = message.resumeToken;
        break;
      case "audio":
        frames.noteActivity();
        audio.play(message.data);
        if (state !== "acting") setState("speaking");
        scheduleSpeakingEnd();
        break;
      case "transcript":
        frames.noteActivity();
        if (message.role === "user" && state === "listening") setState("thinking");
        break;
      case "tool_call":
        frames.noteActivity();
        if (state !== "acting") setState("thinking");
        break;
      case "client_tool_call":
        frames.noteActivity();
        runner.handle(message);
        break;
      case "client_action":
        frames.noteActivity();
        actions.handle(message.frame, replyOn(ws));
        break;
      case "client_tool_cancel":
        runner.drop(message.ids);
        break;
      case "interrupt":
        // The server has already answered the model for every parked call;
        // queued actions the user talked over must not run.
        runner.cancelQueued("The user interrupted before this action ran.");
        audio.flush();
        settle();
        break;
      case "session_ended":
        void teardown("session_ended");
        break;
      case "resume_unavailable":
        void teardown("resume_unavailable", true);
        break;
      case "error":
        record({ event: "error", errorClass: "server" });
        log("server error", message.message);
        if (!established || isFatalServerError(message.message)) {
          void teardown(`error: ${message.message}`, true);
        } else {
          flashError();
        }
        break;
    }
  }

  function connect() {
    connectionGeneration++;
    record({ event: "state", state: "connecting" });
    const socket = new Socket(
      buildWsUrl({
        wsUrl: config.wsUrl,
        apiBase: config.apiBase,
        token: config.token,
        sessionId: config.sessionId,
        resumeToken,
      }),
    );
    ws = socket;
    runner = createRunner(socket);
    established = false;
    socket.onmessage = (event) => {
      if (ws !== socket) return;
      const message = parseServerMessage(event.data);
      if (message) handle(message);
    };
    socket.onerror = () => {
      // close always follows; reconnect is decided there.
    };
    socket.onclose = (event) => {
      if (ws !== socket) return;
      record({ event: "socket_close", code: event?.code });
      ws = null;
      established = false;
      // The server resolves calls from a lost connection. Discard its queued
      // input, and keep its in-flight completion bound to the old socket.
      runner.close();
      runner = null;
      actions.pause();
      if (!active || stopping) return;
      log("socket closed", event && event.code);
      if (reconnectUsed) {
        void teardown("disconnected", true);
        return;
      }
      reconnectUsed = true;
      setState("connecting");
      reconnectTimer = timers.setTimeout(() => {
        reconnectTimer = null;
        void reconnect();
      }, RECONNECT_DELAY_MS);
    };
  }

  async function reconnect() {
    if (!active || stopping) return;
    try {
      // Firebase tokens expire hourly; ask main for a fresh one.
      const fresh = await live.session();
      if (!active || stopping) return;
      config = { ...fresh, sessionId: config.sessionId };
      connect();
    } catch (error) {
      record({ event: "error", errorClass: "reconnect" });
      log("reconnect failed", error);
      void teardown("disconnected", true);
    }
  }

  async function start() {
    if (active) return;
    active = true;
    stopping = false;
    reconnectUsed = false;
    resumeToken = "";
    setState("connecting");
    try {
      config = await live.session();
      if (!active || stopping) return;
      await audio.start({
        onChunk: (base64) => send(audioMessage(base64)),
      });
      audio.setMuted(muted);
      if (!active || stopping) {
        audio.stop();
        return;
      }
      connect();
    } catch (error) {
      record({ event: "error", errorClass: "start" });
      log("start failed", error);
      await teardown(`error: ${error && error.message ? error.message : "start failed"}`, true);
    }
  }

  async function teardown(reason, failed = false) {
    if (!active || stopping) return;
    stopping = true;
    const source = [
      "user",
      "command",
      "window_closed",
      "destroyed",
      "session_ended",
      "resume_unavailable",
      "disconnected",
    ].includes(reason)
      ? reason
      : typeof reason === "string" && reason.startsWith("error:")
        ? "error"
        : "other";
    record({ event: "stop", source });
    for (const timer of [speakingTimer, reconnectTimer, errorTimer, thinkingTimer]) {
      if (timer) timers.clearTimeout(timer);
    }
    speakingTimer = reconnectTimer = errorTimer = thinkingTimer = null;
    // Answer queued tool calls while the socket can still carry the results.
    runner?.close();
    actions.pause();
    frames.stop();
    watcher.stop();
    audio.stop();
    pendingContext = null;
    const socket = ws;
    if (socket && socket.readyState === OPEN && reason !== "session_ended") {
      // Give the server a moment to persist the session before closing.
      await new Promise((resolve) => {
        const timer = timers.setTimeout(resolve, STOP_ACK_MS);
        socket.onclose = () => {
          timers.clearTimeout(timer);
          resolve();
        };
        socket.onmessage = (event) => {
          const message = parseServerMessage(event.data);
          if (message && message.type === "session_ended") {
            timers.clearTimeout(timer);
            resolve();
          }
        };
        socket.send(JSON.stringify(stopSessionMessage()));
      });
    }
    if (socket) {
      socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
    ws = null;
    established = false;
    if (failed) {
      state = "error";
      record({ event: "state", state: "error" });
      onState("error");
      live.setState("error");
    }
    active = false;
    stopping = false;
    if (!failed) setState("idle");
    live.stop(reason);
  }

  return {
    start,
    stop: (reason = "user") => teardown(reason),
    contextChanged: () => actions.contextChanged(),
    relayContext: (message) => actions.relayContext(message),
    setMuted(value) {
      muted = value;
      audio.setMuted(value);
      frames.setMuted(value);
      onMuted(value);
    },
    toggleMute() {
      this.setMuted(!muted);
    },
    get state() {
      return state;
    },
    get muted() {
      return muted;
    },
    get active() {
      return active;
    },
  };
}
