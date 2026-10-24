// Web live orchestrator actions (docs/ditto/live-mode.md, Contract 3). The
// server sends `client_action`; main runs it in the Ditto window through
// ditto-app's own LiveActionDriver and this module answers it exactly once with
// `client_action_result`, after a fresh `client_context`. The wire shapes are
// the web orchestrator's, unchanged; parsing mirrors ditto-app's
// src/lib/liveClientActions.ts so both clients accept the same frames.

export const ERROR_CODES = new Set([
  "unknown_destination",
  "unknown_agent",
  "not_allowed",
  "busy",
  "timeout",
  "send_failed",
  "unsupported",
]);
export const MAX_SUMMARY_CHARS = 500;
export const MAX_REPLY_CHARS = 4000;
export const CONTEXT_DEBOUNCE_MS = 250;
// Under the server's 10 s and 90 s waits. The Ditto window caps a prompt's
// reply wait at 75 s itself and answers with the partial reply, so this outer
// guard only fires when the window stops answering.
export const ACTION_TIMEOUT_MS = 8000;
export const PROMPT_TIMEOUT_MS = 85_000;
const CONTEXT_TIMEOUT_MS = 1000;
const MAX_PROMPT_CHARS = 8000;
const MAX_LEDGER_ENTRIES = 256;
const MAX_DESTINATIONS = 200;

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const optionalId = (value) =>
  value === null || value === undefined
    ? null
    : typeof value === "string" && value.trim() !== ""
      ? value
      : undefined;

// `null` when the frame has no usable id: it cannot be answered.
export function parseClientAction(data) {
  if (!isRecord(data)) return null;
  const { id, action } = data;
  if (typeof id !== "string" || id.trim() === "" || id.length > 200) return null;
  const unsupported = (summary) => ({ ok: false, id, error: "unsupported", summary });
  if (!isRecord(action)) return unsupported("That action was malformed.");
  switch (action.kind) {
    case "navigate":
      return typeof action.destination === "string"
        ? { ok: true, id, action: { kind: "navigate", destination: action.destination } }
        : unsupported("That navigation had no destination.");
    case "open_agent": {
      const agentId = optionalId(action.agentId);
      return agentId
        ? {
            ok: true,
            id,
            action: { kind: "open_agent", agentId, newChat: action.newChat === true },
          }
        : unsupported("That request named no agent.");
    }
    case "new_chat": {
      const agentId = optionalId(action.agentId);
      return agentId === undefined
        ? unsupported("That request named an invalid agent.")
        : { ok: true, id, action: { kind: "new_chat", agentId } };
    }
    case "prompt_agent": {
      const agentId = optionalId(action.agentId);
      const text = typeof action.text === "string" ? action.text.trim() : "";
      if (agentId === undefined) return unsupported("That request named an invalid agent.");
      if (!text || text.length > MAX_PROMPT_CHARS)
        return unsupported("That message was empty or too long.");
      return {
        ok: true,
        id,
        action: { kind: "prompt_agent", agentId, text, awaitReply: action.awaitReply !== false },
      };
    }
    case "set_live_view":
      return action.view === "orb" || action.view === "expanded"
        ? { ok: true, id, action: { kind: "set_live_view", view: action.view } }
        : unsupported("That view is not one Live Mode has.");
    default:
      return unsupported("Live Mode can't do that in this version of Ditto Desktop.");
  }
}

function clip(value, max) {
  const text = String(value).trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function actionResult(id, outcome) {
  const ok = outcome.ok === true;
  return {
    type: "client_action_result",
    id,
    ok,
    summary: clip(outcome.summary || (ok ? "Done." : "That didn't work."), MAX_SUMMARY_CHARS),
    error: ok ? null : ERROR_CODES.has(outcome.error) ? outcome.error : "send_failed",
    reply: ok && typeof outcome.reply === "string" ? clip(outcome.reply, MAX_REPLY_CHARS) : null,
  };
}

// The bridge answers `{ok, result}` like every live tool; the action's own
// outcome is `result`. A bridge-level failure (no Ditto window, no driver) is
// `unsupported` so the model falls back to `ditto_app` or computer use.
function actionOutcome(answer) {
  if (!isRecord(answer))
    return { ok: false, error: "send_failed", summary: "Ditto didn't answer." };
  if (answer.ok !== true)
    return { ok: false, error: "unsupported", summary: answer.error || "Ditto can't do that yet." };
  const result = answer.result;
  if (!isRecord(result) || typeof result.ok !== "boolean")
    return { ok: false, error: "send_failed", summary: "Ditto gave an unreadable answer." };
  return result;
}

const nullableId = (value) => (typeof value === "string" && value ? value : null);
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

export function contextMessage(result) {
  const source = isRecord(result) ? result : {};
  const destinations = (Array.isArray(source.destinations) ? source.destinations : [])
    .filter((item) => isRecord(item) && typeof item.key === "string" && item.key)
    .slice(0, MAX_DESTINATIONS)
    .map((item) => ({
      key: item.key,
      label: text(item.label, 80),
      ...(typeof item.description === "string" ? { description: text(item.description, 200) } : {}),
      ...(Array.isArray(item.aliases)
        ? { aliases: item.aliases.filter((alias) => typeof alias === "string") }
        : {}),
    }));
  return {
    type: "client_context",
    route: text(source.route, 2000) || "/",
    surface: text(source.surface, 200),
    activeAgentId: nullableId(source.activeAgentId),
    activeThreadId: nullableId(source.activeThreadId),
    destinations,
  };
}

export function createClientActions({
  tool,
  // Sends on the current socket; drops the message when it is not open.
  sendContext,
  log = () => {},
  debounceMs = CONTEXT_DEBOUNCE_MS,
  actionTimeoutMs = ACTION_TIMEOUT_MS,
  promptTimeoutMs = PROMPT_TIMEOUT_MS,
  setTimeout: startTimer = globalThis.setTimeout,
  clearTimeout: stopTimer = globalThis.clearTimeout,
}) {
  // id -> { result, reply }. `result` is null while the action runs; `reply`
  // is bound to the socket that last asked, since results only travel there.
  const ledger = new Map();
  let contextTimer = null;
  let lastSent = "";
  let ready = false;

  function withTimeout(promise, ms, fallback) {
    let timer;
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = startTimer(() => resolve(fallback), ms);
      }),
    ]).finally(() => stopTimer(timer));
  }

  async function flushContext(force) {
    if (contextTimer) stopTimer(contextTimer);
    contextTimer = null;
    if (!ready) return;
    const answer = await withTimeout(
      Promise.resolve()
        .then(() => tool("ditto_client_context", {}))
        .catch(() => null),
      CONTEXT_TIMEOUT_MS,
      null,
    );
    if (!ready || !answer || answer.ok !== true) return;
    const message = contextMessage(answer.result);
    const serialized = JSON.stringify(message);
    if (!force && serialized === lastSent) return;
    lastSent = serialized;
    sendContext(message);
  }

  function remember(id, entry) {
    ledger.delete(id);
    ledger.set(id, entry);
    while (ledger.size > MAX_LEDGER_ENTRIES) ledger.delete(ledger.keys().next().value);
  }

  // A fresh, undebounced context goes out right before every result so the
  // location the server attaches to the tool result is where the action left
  // the user.
  async function answer(entry) {
    await flushContext(true);
    entry.reply(entry.result);
  }

  async function run(action) {
    const prompt = action.kind === "prompt_agent";
    const timedOut = {
      ok: false,
      error: "timeout",
      summary: prompt ? "The agent didn't answer in time." : "Ditto took too long to do that.",
    };
    return withTimeout(
      Promise.resolve()
        .then(() => tool("ditto_client_action", action))
        .then(actionOutcome, (error) => {
          log("client action failed", error);
          return { ok: false, error: "send_failed", summary: "Something went wrong doing that." };
        }),
      prompt ? promptTimeoutMs : actionTimeoutMs,
      timedOut,
    );
  }

  function handle(data, reply) {
    const parsed = parseClientAction(data);
    if (!parsed) return;
    const known = ledger.get(parsed.id);
    if (known) {
      // Never run an action twice. A finished one is answered again from the
      // ledger; a running one answers the latest asker when it finishes.
      known.reply = reply;
      if (known.result) void answer(known);
      return;
    }
    const entry = { result: null, reply };
    remember(parsed.id, entry);
    if (!parsed.ok) {
      entry.result = actionResult(parsed.id, parsed);
      void answer(entry);
      return;
    }
    void run(parsed.action).then((outcome) => {
      entry.result = actionResult(parsed.id, outcome);
      return answer(entry);
    });
  }

  return {
    handle,
    // Every `session_started`, resumed or not; the server holds no context yet.
    sessionStarted() {
      ready = true;
      lastSent = "";
      void flushContext(true);
    },
    // Route or agent changed in the Ditto window.
    contextChanged() {
      if (!ready) return;
      if (contextTimer) stopTimer(contextTimer);
      contextTimer = startTimer(() => void flushContext(false), debounceMs);
    },
    // Socket gone. The ledger stays so a resent id is never executed again.
    pause() {
      ready = false;
      if (contextTimer) stopTimer(contextTimer);
      contextTimer = null;
    },
  };
}
