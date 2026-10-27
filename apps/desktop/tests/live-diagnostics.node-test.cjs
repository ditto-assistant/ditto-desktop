const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  createLiveDiagnostics,
  registerLiveDiagnosticIPC,
  sanitizeLiveDiagnostic,
  liveDiagnosticStopSource,
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_RATE,
} = require("../src/live/diagnostics.cjs");

test("diagnostics retain only fixed metadata and exclude private payload fields", () => {
  const privatePayload = "private-token-text-audio-image-url";
  const extra = Object.fromEntries(
    [
      "token",
      "url",
      "query",
      "args",
      "result",
      "error",
      "text",
      "transcript",
      "audio",
      "screenshot",
      "title",
    ].map((key) => [key, { nested: privatePayload }]),
  );
  const examples = [
    { event: "state", state: "acting", generation: 2 },
    { event: "capability", status: "available", count: 2, generation: 2 },
    { event: "socket_close", code: 1006, generation: 2 },
    { event: "error", errorClass: "server", generation: 2 },
    { event: "stop", source: "session_ended", generation: 2 },
    { event: "tool", tool: "computer_open_app", outcome: "ok" },
    { event: "native_tool", tool: "computer_press_key", outcome: "error", verified: false },
  ];
  for (const entry of examples) {
    assert.deepEqual(sanitizeLiveDiagnostic({ ...entry, ...extra }), entry);
    assert.equal(
      JSON.stringify(sanitizeLiveDiagnostic({ ...entry, ...extra })).includes(privatePayload),
      false,
    );
  }
  for (const entry of [
    { event: privatePayload },
    { event: "state", state: privatePayload },
    { event: "stop", source: privatePayload },
    { event: "error", errorClass: privatePayload },
    { event: "tool", tool: privatePayload, outcome: "ok" },
    { event: "tool", tool: "computer_click", outcome: privatePayload },
    { event: "socket_close", code: privatePayload, generation: 1 },
    { event: "socket_close", code: 1006, generation: -1 },
    { event: "socket_close", code: 1006, generation: Number.MAX_SAFE_INTEGER + 1 },
  ])
    assert.equal(sanitizeLiveDiagnostic(entry), null);
  assert.equal(liveDiagnosticStopSource(`error: ${privatePayload}`), "error");
  assert.equal(liveDiagnosticStopSource(privatePayload), "other");
});

test("capability metadata cannot retain raw lists or inconsistent counts", () => {
  const entry = { event: "capability", status: "available", count: 1, generation: 2 };
  assert.deepEqual(
    sanitizeLiveDiagnostic({
      ...entry,
      tools: ["private-tool-name"],
      config: "private",
      flags: "private",
    }),
    entry,
  );
  for (const invalid of [
    { ...entry, count: -1 },
    { ...entry, count: 9 },
    { ...entry, count: "1" },
    { ...entry, count: 0 },
    { ...entry, status: "unknown" },
    { ...entry, status: "unavailable" },
    { ...entry, status: "private" },
  ])
    assert.equal(sanitizeLiveDiagnostic(invalid), null);
  assert.deepEqual(sanitizeLiveDiagnostic({ ...entry, status: "unknown", count: 0 }), {
    ...entry,
    status: "unknown",
    count: 0,
  });
  assert.deepEqual(sanitizeLiveDiagnostic({ ...entry, status: "unavailable", count: 0 }), {
    ...entry,
    status: "unavailable",
    count: 0,
  });
});

test("the local diagnostic file is owner-only and retains a bounded sanitized tail", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-live-diagnostics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "logs", "live-diagnostics.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(
    file,
    JSON.stringify([{ event: "stop", source: "user", token: "old-private-payload" }]),
  );
  let clock = 0;
  const sink = createLiveDiagnostics(file, { now: () => clock });
  sink.record({ event: "state", state: "connecting" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file))[0], { event: "stop", source: "user" });
  for (let generation = 0; generation < MAX_DIAGNOSTIC_EVENTS + 5; generation++) {
    clock += 1000;
    sink.record({ event: "socket_close", generation, code: 1006, args: "new-private-payload" });
  }
  sink.record({ event: "tool", tool: "private-tool-name", outcome: "ok" });
  const bytes = fs.readFileSync(file);
  const entries = JSON.parse(bytes);
  assert.equal(entries.length, MAX_DIAGNOSTIC_EVENTS);
  assert.equal(entries[0].generation, 5);
  assert.equal(bytes.includes("private"), false);
  assert.ok(bytes.length <= MAX_DIAGNOSTIC_BYTES);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  createLiveDiagnostics(file).record({ event: "stop", source: "user" });
  assert.equal(JSON.parse(fs.readFileSync(file)).length, MAX_DIAGNOSTIC_EVENTS);
  fs.writeFileSync(file, "x".repeat(MAX_DIAGNOSTIC_BYTES + 1));
  createLiveDiagnostics(file).record({ event: "stop", source: "quit" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), [{ event: "stop", source: "quit" }]);
});

test("diagnostic persistence failure cannot interrupt Live", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-live-diagnostics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.doesNotThrow(() => createLiveDiagnostics(dir).record({ event: "stop", source: "user" }));
});

test("diagnostic write rate is bounded independently of payload volume", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ditto-live-diagnostics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 0;
  const sink = createLiveDiagnostics(path.join(dir, "live.json"), { now: () => clock });
  const accepted = Array.from({ length: 1000 }, () =>
    sink.record({ event: "state", state: "acting" }),
  );
  assert.equal(accepted.filter(Boolean).length, MAX_DIAGNOSTIC_RATE - 3);
  assert.equal(sink.record({ event: "socket_close", code: 1006, generation: 1 }), true);
  assert.equal(sink.record({ event: "error", errorClass: "server" }), true);
  assert.equal(sink.record({ event: "stop", source: "session_ended" }), true);
  assert.equal(sink.record({ event: "stop", source: "other" }), false);
  const entries = JSON.parse(fs.readFileSync(path.join(dir, "live.json")));
  assert.equal(entries.length, MAX_DIAGNOSTIC_RATE);
  assert.deepEqual(
    entries.slice(-3).map((entry) => entry.event),
    ["socket_close", "error", "stop"],
  );
  clock = 1000;
  assert.equal(sink.record({ event: "stop", source: "user" }), true);
});

test("only the current aura main frame can record diagnostic IPC", () => {
  const ipcMain = new EventEmitter();
  const contents = { mainFrame: {} };
  let window = { webContents: contents, isDestroyed: () => false };
  const entries = [];
  const dispose = registerLiveDiagnosticIPC({
    ipcMain,
    getAuraWindow: () => window,
    record: (entry) => entries.push(sanitizeLiveDiagnostic(entry)),
  });
  const entry = { event: "state", state: "acting", token: "private" };
  ipcMain.emit("ditto-live:diagnostic", { sender: {}, senderFrame: contents.mainFrame }, entry);
  ipcMain.emit("ditto-live:diagnostic", { sender: contents, senderFrame: {} }, entry);
  assert.deepEqual(entries, []);
  ipcMain.emit(
    "ditto-live:diagnostic",
    { sender: contents, senderFrame: contents.mainFrame },
    entry,
  );
  window = null;
  ipcMain.emit(
    "ditto-live:diagnostic",
    { sender: contents, senderFrame: contents.mainFrame },
    entry,
  );
  assert.deepEqual(entries, [{ event: "state", state: "acting" }]);
  dispose();
  assert.equal(ipcMain.listenerCount("ditto-live:diagnostic"), 0);
});
