// Mock `window.dittoLive`, realtime socket and audio engine for dev.html and
// tests. The mock server speaks the Contract 1 wire format so the real
// session code runs unchanged against it.

import { OUTPUT_SAMPLE_RATE, float32ToInt16, int16ToBase64 } from "./pcm.js";

// 1x1 JPEG; frames only need to be valid base64 for the protocol.
const PIXEL_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

const APPS = [
  { app: "Ditto Desktop", bundleId: "ai.heyditto.local", title: "Ditto", isDitto: true },
  { app: "Safari", bundleId: "com.apple.Safari", title: "Apple", isDitto: false },
  { app: "Notes", bundleId: "com.apple.Notes", title: "Groceries", isDitto: false },
];

export function createMockLive({ log = () => {}, toolDelayMs = 400 } = {}) {
  const listeners = new Set();
  const calls = [];
  let appIndex = 0;
  const live = {
    calls,
    state: "idle",
    interactive: false,
    async session() {
      calls.push(["session"]);
      return {
        token: "mock-token",
        apiBase: "https://mock.ditto.invalid",
        wsUrl: "wss://mock.ditto.invalid/api/v2/realtime/ws",
        sessionId: "mock-session",
      };
    },
    async captureScreen(opts) {
      calls.push(["captureScreen", opts]);
      return {
        data: PIXEL_JPEG,
        mimeType: "image/jpeg",
        width: 1,
        height: 1,
        display: { x: 0, y: 0, width: 1512, height: 982, scaleFactor: 2 },
      };
    },
    async frontmost() {
      return APPS[appIndex];
    },
    switchApp(index = (appIndex + 1) % APPS.length) {
      appIndex = index;
    },
    async tool(name, args) {
      calls.push(["tool", name, args]);
      log("tool", name, args);
      await new Promise((resolve) => setTimeout(resolve, toolDelayMs));
      if (name === "computer_fail") return { ok: false, error: "Mock failure" };
      return { ok: true, result: { done: name } };
    },
    setState(state) {
      live.state = state;
    },
    setInteractive(value) {
      live.interactive = value;
    },
    stop(reason) {
      calls.push(["stop", reason]);
      log("stop", reason);
    },
    onCommand(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    command(type) {
      for (const cb of listeners) cb({ type });
    },
  };
  return live;
}

// Mock realtime server. `MockRealtimeSocket.last` is the most recent socket so
// a dev panel can push server frames into it.
export class MockRealtimeSocket {
  static last = null;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    MockRealtimeSocket.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      this.serve({ type: "session_started", resumeToken: "mock-resume" });
    }, 300);
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.type === "stop_session") this.serve({ type: "session_ended" });
  }

  serve(message) {
    if (this.readyState !== 1) return;
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  // Server-side helpers for the dev panel.
  speak(seconds = 1.6) {
    const chunk = OUTPUT_SAMPLE_RATE / 10;
    const total = Math.round(seconds * 10);
    for (let n = 0; n < total; n++) {
      const samples = new Float32Array(chunk);
      for (let i = 0; i < chunk; i++) {
        const t = (n * chunk + i) / OUTPUT_SAMPLE_RATE;
        const envelope = 0.5 + 0.5 * Math.sin(t * 7);
        samples[i] = 0.25 * envelope * Math.sin(2 * Math.PI * 220 * t);
      }
      setTimeout(
        () => this.serve({ type: "audio", data: int16ToBase64(float32ToInt16(samples)) }),
        n * 90,
      );
    }
  }

  toolCall(name = "computer_click", args = { x: 500, y: 500 }) {
    this.serve({ type: "client_tool_call", id: `call-${Date.now()}`, name, args });
  }
}

// Fake audio engine: no mic permission, synthetic input level, and playback
// that tracks how long queued audio would take to play.
export function createMockAudio({ now = () => performance.now() } = {}) {
  let playingUntil = 0;
  let muted = false;
  let started = false;
  return {
    async start() {
      started = true;
    },
    stop() {
      started = false;
      playingUntil = 0;
    },
    play(base64) {
      const seconds = (base64.length * 0.75) / 2 / OUTPUT_SAMPLE_RATE;
      playingUntil = Math.max(playingUntil, now()) + seconds * 1000;
    },
    flush() {
      playingUntil = 0;
    },
    setMuted(value) {
      muted = value;
    },
    playbackRemainingMs: () => Math.max(0, playingUntil - now()),
    inputLevel: () => (started && !muted ? 0.15 + 0.35 * Math.abs(Math.sin(now() / 260)) : 0),
    outputLevel: () => (playingUntil > now() ? 0.4 + 0.5 * Math.abs(Math.sin(now() / 120)) : 0),
  };
}
