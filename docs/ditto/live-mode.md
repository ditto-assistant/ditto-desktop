# Ditto Desktop Live Mode (immersive, computer-use)

Status: in development on integration branch `feat/live-mode` (stacked on PR #32 `feat/desktop-computer-use`).
Owner/gate: the orchestrating Claude session. Feature PRs target `feat/live-mode`, never `main`.

## Goal

Starting Live Mode in Ditto Desktop shows a small draggable **aura** floating above every app on the
macOS desktop. The user talks; a Gemini Live realtime agent hears them, **sees the screen** (~1 fps
frames), and can **act on the computer** (click, type, keys, scroll, open apps) through the existing
cmux-cua Computer Use sidecar, and can drive the Ditto app itself. When the user leaves the Ditto
window the agent knows it from the frames plus a frontmost-app context note.

Hard constraints

- No changes to the ditto-app repo or to production behaviour. Desktop-only code lives in
  `apps/desktop/**`. Backend additions are additive and gated by the per-user flag
  `desktop_live_mode` **and** an explicit `client=ditto-desktop` query param. Without both, the
  realtime endpoint behaves byte-for-byte as before.
- Reuse `ComputerService` (`apps/desktop/src/computer-service.cjs`) sessions; never bypass its
  permission gate, serialization, or stop/generation logic. Computer Use must be enabled by the user.
- Stopping is always one action away: aura stop button, Esc-hold/global shortcut, and disabling
  Computer Use all end the live session and close the computer session (cursor disappears).

## Components and file ownership

| Piece                                                                                         | Owner workstream      | Files                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend client-tool protocol + desktop toolset + flag                                         | `backend-live-tools`  | backend repo `pkg/api/v2/realtime*.go`, new `realtime_desktop_tools.go`                                                                                                                                                         |
| Aura overlay window, entry points, permissions, token bridge                                  | `desktop-aura-shell`  | `apps/desktop/src/main.cjs` (wiring only), `src/live/aura-window.cjs`, `src/live/aura-preload.cjs`, `src/live/aura.html`, `preload.cjs`, `desktop-shell.js` (Live button), `electron-builder.ditto.yml`, `renderer/` token push |
| Main-process live bridge (screen capture, frontmost app, computer adapter, Ditto app actions) | `desktop-live-bridge` | `src/live/live-bridge.cjs` + `tests/live-bridge*.node-test.cjs`                                                                                                                                                                 |
| Live client in the aura renderer (WS, mic, playback, frames, tool round-trip, aura visuals)   | `desktop-live-client` | `src/live/client/**` + `tests/live-client*.node-test.cjs`                                                                                                                                                                       |

Stay inside your files. If you need a change in someone else's file, write it in your PR body under
"Requests for other workstreams" and the orchestrator integrates it.

## Contract 1: backend realtime protocol additions

Endpoint unchanged: `GET /api/v2/realtime/ws?token=<firebase>&session_id=<id>&client=ditto-desktop[&activity_detection=client_vad]`.

When `client=ditto-desktop` AND flag `desktop_live_mode` is on for the user:

- System prompt gets a desktop addendum (you see the user's screen as periodic images; coordinates are
  normalized 0-1000 on the latest frame; confirm before destructive or sending/purchasing actions;
  narrate briefly what you do; prefer `ditto_app` for Ditto-internal navigation).
- The desktop toolset below is declared to Gemini in addition to normal tools.
- Consecutive tool-call guard for desktop tools is raised to 30 (normal tools keep 5).

Desktop toolset (server-declared; executed on the client):

| name                 | args                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `computer_click`     | `{x:int 0-1000, y:int 0-1000, button?: "left"\|"right", double?: bool}`                          |
| `computer_type_text` | `{text: string}`                                                                                 |
| `computer_press_key` | `{key: string, modifiers?: string[]}` (e.g. key "return", modifiers ["cmd"])                     |
| `computer_scroll`    | `{x:int, y:int, direction:"up"\|"down"\|"left"\|"right", amount?: int}`                          |
| `computer_drag`      | `{from_x, from_y, to_x, to_y}`                                                                   |
| `computer_open_app`  | `{name: string}`                                                                                 |
| `computer_get_state` | `{}` -> frontmost app, window title, screen size, and forces a fresh frame                       |
| `ditto_app`          | `{action: "show"\|"hide"\|"navigate"\|"new_chat"\|"ask_code", target?: string, prompt?: string}` |

Wire messages (new types only; old ones unchanged):

- server -> client: `{"type":"client_tool_call","id":"<call id>","name":"computer_click","args":{...}}`
- client -> server: `{"type":"client_tool_result","id":"<call id>","ok":true,"result":{...}|"text","error":"..."?}`
  Backend parks the Gemini function call (like `realtime_user_approval.go`) and sends the
  `FunctionResponse` when the result arrives; 30 s timeout -> error response. Existing `tool_call` /
  `tool_result` display messages are still emitted so transcripts render.
- client -> server: `{"type":"context","text":"User switched to Safari — \"Apple\""}` sent as realtime
  text input that does not by itself start a model turn (desktop clients only).
- Screen frames reuse existing `{"type":"image","data":"<b64 jpeg>","mimeType":"image/jpeg"}`.

## Contract 2: aura preload API (`window.dittoLive`, aura window only)

```ts
interface DittoLive {
  session(): Promise<{
    token: string;
    apiBase: string;
    wsUrl: string;
    sessionId: string;
    voice?: string;
  }>;
  captureScreen(opts?: {
    maxWidth?: number;
    quality?: number;
  }): Promise<{
    data: string;
    mimeType: "image/jpeg";
    width: number;
    height: number;
    display: { x: number; y: number; width: number; height: number; scaleFactor: number };
  }>;
  frontmost(): Promise<{ app: string; bundleId?: string; title?: string; isDitto: boolean }>;
  tool(name: string, args: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }>; // computer_* and ditto_app
  setState(
    state: "connecting" | "listening" | "thinking" | "speaking" | "acting" | "error" | "idle",
  ): void;
  setInteractive(interactive: boolean): void; // toggles click-through of the transparent window
  stop(reason?: string): void; // ends live mode, closes aura + computer session
  onCommand(cb: (cmd: { type: "start" | "stop" | "mute" | "unmute" }) => void): () => void;
}
```

Main side registration (implemented by `desktop-live-bridge`, wired by `desktop-aura-shell`):

```js
// src/live/live-bridge.cjs
module.exports.registerLiveBridge = ({ ipcMain, computer /* ComputerService */, getMainWindow, getAuraWindow, getSession /* async () => {token,...} */, emit }) => ({ dispose, onStop(cb) })
```

IPC channel names: `ditto-live:session`, `ditto-live:capture`, `ditto-live:frontmost`, `ditto-live:tool`,
`ditto-live:state`, `ditto-live:interactive`, `ditto-live:stop`, push `ditto-live:command`.

Coordinate mapping: tool x/y are 0-1000 normalized over the **display captured in the latest frame**;
the bridge maps to global screen points (display bounds) before calling cmux `click` etc. The bridge
holds one `ComputerService.createSession()` for the life of the live session and satisfies the
session's "verified" barrier by taking a desktop state observation before the first action and after
any action that changes focus. The aura window itself must be excluded from captures where possible
(`setContentProtection(true)`), and clicks must never land on the aura.

## Flow

1. User clicks **Live** in the Desktop rail (or presses Cmd+Shift+L). Main ensures Computer Use is
   enabled (else opens the existing setup window), fetches a fresh Firebase token from the main renderer,
   opens the aura window, sends `start`.
2. Aura client connects WS with `client=ditto-desktop`, streams mic PCM16 16 kHz, plays 24 kHz audio,
   sends a screen frame every 1 s (and immediately after each tool action), and sends `context` when
   the frontmost app changes.
3. On `client_tool_call` the client calls `dittoLive.tool(name,args)`, sets state `acting`, and replies
   with `client_tool_result`.
4. Stop: aura button, shortcut, `stop_session`, WS close, or Computer Use disabled -> everything torn down.

## Testing expectations

Each PR: focused unit tests (`node --test tests/*.node-test.cjs` style for desktop, `go test` for
backend), lint, and a short runtime transcript. Do not touch `~/Applications/Ditto Desktop.app` or the
`ditto-desktop-local` checkout (an hourly Codex QA agent owns them). End-to-end QA happens after
integration on `feat/live-mode`.
