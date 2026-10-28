// Web live orchestrator actions (docs/ditto/live-mode.md, Contract 3). The
// aura relays: each `client_action` frame goes to main, which hands it to
// ditto-app's own createLiveClientActions in the Ditto window (ledger,
// history steps, agent refetch, context-before-result). The aura only puts
// the returned `client_context` and `client_action_result` on the socket that
// delivered the action, and answers `unsupported` itself when the bundled
// ditto-app has no driver, so the model falls back to `ditto_app` or computer use.

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
// Under the server's 10 s and 90 s waits. ditto-app caps a prompt's reply wait
// at 75 s itself and answers with the partial reply, so these only fire when
// the Ditto window stops answering.
export const ACTION_TIMEOUT_MS = 8000;
export const PROMPT_TIMEOUT_MS = 85_000;
const CONTEXT_TIMEOUT_MS = 1000;
const MAX_LEDGER_ENTRIES = 256;
const MAX_DESTINATIONS = 200;

const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);

function clip(value, max) {
  const text = String(value).trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

// ditto-app already clips and codes its results; this keeps a malformed one
// from reaching the server.
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

const UNSUPPORTED = {
  ok: false,
  error: "unsupported",
  summary: "This version of Ditto can't do that yet. Use ditto_app or the screen instead.",
};

const nullableId = (value) => (typeof value === "string" && value ? value : null);
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

export function contextMessage(source) {
  const value = isRecord(source) ? source : {};
  const destinations = (Array.isArray(value.destinations) ? value.destinations : [])
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
    route: text(value.route, 2000) || "/",
    surface: text(value.surface, 200),
    activeAgentId: nullableId(value.activeAgentId),
    activeThreadId: nullableId(value.activeThreadId),
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
  // id -> { result, reply }. ditto-app keeps the real ledger; this one keeps a
  // resent id from being forwarded twice and binds the answer to the socket
  // that last asked, including ids this aura timed out or answered itself.
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

  const call = (name, args, ms, fallback) =>
    withTimeout(
      Promise.resolve()
        .then(() => tool(name, args))
        .catch((error) => {
          log(`${name} failed`, error);
          return null;
        }),
      ms,
      fallback,
    );

  function sendIfNew(message, force) {
    if (!ready) return;
    const serialized = JSON.stringify(message);
    if (!force && serialized === lastSent) return;
    lastSent = serialized;
    sendContext(message);
  }

  // The driverless context (route only), or the shim's current one.
  async function refreshContext(force) {
    if (contextTimer) stopTimer(contextTimer);
    contextTimer = null;
    if (!ready) return;
    const answer = await call("ditto_client_context", {}, CONTEXT_TIMEOUT_MS, null);
    if (answer?.ok === true) sendIfNew(contextMessage(answer.result), force);
  }

  function remember(id, entry) {
    ledger.delete(id);
    ledger.set(id, entry);
    while (ledger.size > MAX_LEDGER_ENTRIES) ledger.delete(ledger.keys().next().value);
  }

  async function run(frame) {
    const prompt = frame.action?.kind === "prompt_agent";
    const answer = await call(
      "ditto_client_action",
      { id: frame.id, action: frame.action },
      prompt ? promptTimeoutMs : actionTimeoutMs,
      "timeout",
    );
    if (answer === "timeout")
      return {
        result: actionResult(frame.id, {
          ok: false,
          error: "timeout",
          summary: prompt ? "The agent didn't answer in time." : "Ditto took too long to do that.",
        }),
        context: null,
      };
    // The bridge answers `{ok, result: {result, context}}` like every live tool.
    const relayed = answer?.ok === true && isRecord(answer.result) ? answer.result : null;
    if (!relayed) log("client action failed", answer?.error);
    if (!isRecord(relayed?.result)) return { result: actionResult(frame.id, UNSUPPORTED) };
    return {
      result: actionResult(frame.id, relayed.result),
      context: isRecord(relayed.context) ? contextMessage(relayed.context) : null,
    };
  }

  // The context ditto-app sent right before its result goes out first; when it
  // sent none (no driver, timeout), the aura reads one itself.
  async function answer(entry) {
    if (entry.context) sendIfNew(entry.context, true);
    else await refreshContext(true);
    entry.reply(entry.result);
  }

  function handle(frame, reply) {
    if (!isRecord(frame) || typeof frame.id !== "string" || !frame.id.trim()) return;
    if (frame.id.length > 200) return;
    const known = ledger.get(frame.id);
    if (known) {
      known.reply = reply;
      if (known.result) void answer(known);
      return;
    }
    const entry = { result: null, context: null, reply };
    remember(frame.id, entry);
    void run(frame).then((outcome) => {
      entry.result = outcome.result;
      entry.context = outcome.context ?? null;
      return answer(entry);
    });
  }

  return {
    handle,
    // Every `session_started`, resumed or not; the server holds no context yet.
    async sessionStarted() {
      ready = true;
      lastSent = "";
      const answer = await call("ditto_client_session", { ready: true }, CONTEXT_TIMEOUT_MS, null);
      // With a shim, ditto-app sends its own session-start context.
      if (answer?.result?.shim !== true) await refreshContext(true);
    },
    // A context ditto-app sent (debounced navigation or agent change).
    relayContext(message) {
      if (isRecord(message)) sendIfNew(contextMessage(message), false);
    },
    // The Ditto window navigated; covers ditto-apps without a shim.
    contextChanged() {
      if (!ready) return;
      if (contextTimer) stopTimer(contextTimer);
      contextTimer = startTimer(() => void refreshContext(false), debounceMs);
    },
    // Socket gone. The ledger stays so a resent id is never executed again.
    pause() {
      if (!ready) return;
      ready = false;
      if (contextTimer) stopTimer(contextTimer);
      contextTimer = null;
      void call("ditto_client_session", { ready: false }, CONTEXT_TIMEOUT_MS, null);
    },
  };
}
