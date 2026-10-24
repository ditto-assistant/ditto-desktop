// Client-executed tool calls (`client_tool_call`). Calls run one at a time in
// arrival order because they act on one shared mouse and keyboard. Every call
// is answered exactly once: success, bridge error, thrown error, timeout, or
// session teardown all produce a `client_tool_result`. The exception is a call
// the server cancels while it is still queued: it is dropped unanswered.

export const TOOL_TIMEOUT_MS = 25_000; // under the backend's 30 s park timeout
// The backend parks at most 8 calls; anything past this is a misbehaving server.
export const MAX_QUEUED_CALLS = 16;

export function createToolRunner({
  tool,
  respond,
  afterAction = async () => {},
  onBusyChange = () => {},
  timeoutMs = TOOL_TIMEOUT_MS,
  setTimeout: startTimer = globalThis.setTimeout,
  clearTimeout: stopTimer = globalThis.clearTimeout,
}) {
  const queue = [];
  let running = false;
  let closed = false;
  const answered = new Set();

  function answer(id, outcome) {
    if (answered.has(id)) return;
    answered.add(id);
    respond(id, outcome);
  }

  async function execute(call) {
    if (!call.name) return { ok: false, error: "Tool call has no name" };
    let timer;
    const timeout = new Promise((resolve) => {
      timer = startTimer(
        () => resolve({ ok: false, error: `${call.name} timed out after ${timeoutMs} ms` }),
        timeoutMs,
      );
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve()
          .then(() => tool(call.name, call.args))
          .then(normalizeOutcome, (error) => ({ ok: false, error: errorText(error) })),
        timeout,
      ]);
      return outcome;
    } finally {
      stopTimer(timer);
    }
  }

  async function drain() {
    if (running) return;
    running = true;
    onBusyChange(true);
    try {
      while (queue.length > 0) {
        if (closed) break;
        const call = queue.shift();
        const outcome = await execute(call);
        if (closed) {
          answer(call.id, { ok: false, error: "Live session ended" });
          break;
        }
        try {
          await afterAction(call, outcome);
        } catch {
          // A failed post-action frame must not swallow the tool result.
        }
        answer(call.id, outcome);
      }
    } finally {
      running = false;
      onBusyChange(false);
    }
  }

  return {
    open() {
      closed = false;
      answered.clear();
    },
    handle(call) {
      if (closed) {
        answer(call.id, { ok: false, error: "Live session ended" });
        return;
      }
      if (queue.length >= MAX_QUEUED_CALLS) {
        answer(call.id, { ok: false, error: "Too many desktop actions are waiting." });
        return;
      }
      queue.push(call);
      void drain();
    },
    // Answers anything still queued so the backend is never left parked.
    close(reason = "Live session ended") {
      closed = true;
      this.cancelQueued(reason);
    },
    // Forgets queued calls the server already resolved; nothing is answered for
    // them, and a call already running still finishes and reports.
    drop(ids) {
      const dropped = new Set(ids);
      for (let i = queue.length - 1; i >= 0; i--) {
        if (!dropped.has(queue[i].id)) continue;
        answered.add(queue[i].id);
        queue.splice(i, 1);
      }
    },
    // Drops calls that have not started; the one in flight cannot be recalled.
    cancelQueued(reason) {
      for (const call of queue.splice(0)) answer(call.id, { ok: false, error: reason });
    },
    isBusy: () => running,
    pending: () => queue.length,
  };
}

function normalizeOutcome(value) {
  if (!value || typeof value !== "object" || typeof value.ok !== "boolean") {
    return { ok: false, error: "Tool returned an invalid response" };
  }
  return value.ok
    ? { ok: true, result: value.result }
    : { ok: false, error: value.error || "Tool failed", result: value.result };
}

function errorText(error) {
  if (error instanceof Error) return error.message || error.name;
  return typeof error === "string" && error ? error : "Tool failed";
}
