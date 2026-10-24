// Wire protocol for /api/v2/realtime/ws (docs/ditto/live-mode.md, Contract 1).

const REALTIME_PATH = "/api/v2/realtime/ws";

// `wsUrl` from dittoLive.session() may be the full endpoint or just an origin;
// fall back to deriving it from `apiBase` (http -> ws).
export function buildWsUrl({ wsUrl, apiBase, token, sessionId, resumeToken, clientVad }) {
  let base = wsUrl || String(apiBase || "").replace(/^http/, "ws");
  if (!base) throw new Error("Live session has no wsUrl or apiBase");
  const url = new URL(base);
  if (!url.pathname.endsWith(REALTIME_PATH)) {
    url.pathname = url.pathname.replace(/\/+$/, "") + REALTIME_PATH;
  }
  url.searchParams.set("token", token);
  url.searchParams.set("session_id", sessionId);
  url.searchParams.set("client", "ditto-desktop");
  if (clientVad) url.searchParams.set("activity_detection", "client_vad");
  if (resumeToken) url.searchParams.set("resume_token", resumeToken);
  return url.toString();
}

export const audioMessage = (data) => ({ type: "audio", data });
export const imageMessage = (data, mimeType = "image/jpeg") => ({ type: "image", data, mimeType });
export const contextMessage = (text) => ({ type: "context", text });
export const stopSessionMessage = () => ({ type: "stop_session" });

export function clientToolResultMessage(id, outcome) {
  const message = { type: "client_tool_result", id, ok: outcome.ok === true };
  if (outcome.result !== undefined) message.result = outcome.result;
  if (!message.ok) message.error = outcome.error || "Tool failed";
  return message;
}

const str = (value) => (typeof value === "string" ? value : "");

// Normalizes one server frame into a small tagged object, or null for frames
// that are malformed or that this client does not act on.
export function parseServerMessage(raw) {
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  switch (data.type) {
    case "session_started":
      return {
        type: "session_started",
        resumed: data.resumed === true,
        resumeToken: str(data.resumeToken),
      };
    case "session_resumption_ready":
      return str(data.resumeToken)
        ? { type: "session_resumption_ready", resumeToken: data.resumeToken }
        : null;
    case "audio":
      return str(data.data) ? { type: "audio", data: data.data } : null;
    case "transcript":
      return data.role === "user" || data.role === "assistant"
        ? { type: "transcript", role: data.role, text: str(data.text) }
        : null;
    case "tool_call":
      return { type: "tool_call", id: str(data.id), name: str(data.name) };
    case "tool_result":
      return { type: "tool_result", id: str(data.id) };
    case "client_tool_call":
      // A call without an id cannot be answered, so it is dropped here; one
      // with a missing name still reaches the runner and is answered with an error.
      if (!str(data.id)) return null;
      return {
        type: "client_tool_call",
        id: data.id,
        name: str(data.name),
        args: data.args && typeof data.args === "object" ? data.args : {},
      };
    case "interrupt":
      return { type: "interrupt" };
    case "session_ended":
      return { type: "session_ended", reason: str(data.reason) };
    case "resume_unavailable":
      return { type: "resume_unavailable", message: str(data.message) };
    case "error":
      return { type: "error", message: str(data.message) || "Live mode error" };
    default:
      return null;
  }
}

// Mirrors the web client: a depleted balance ends the session rather than
// leaving the user talking to a session that will never answer.
export function isFatalServerError(message) {
  return /balance|depleted/i.test(message);
}
