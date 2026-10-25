const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const readline = require("node:readline");
const QRCode = require("qrcode");
const { GoogleMessagesLocal } = require("./googlemessages-local.cjs");
const { imessageText } = require("./imessage-text.cjs");

const execFileAsync = promisify(execFile);

class Sidecar {
  constructor(binary, stateDir, { onEvent = () => {}, onDiagnostic = () => {} } = {}) {
    this.binary = binary;
    this.stateDir = stateDir;
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.onEvent = onEvent;
    this.onDiagnostic = onDiagnostic;
  }

  ensureStarted() {
    if (this.child && this.child.exitCode === null) return this.child;
    if (!fs.existsSync(this.binary))
      throw new Error(`Local channel component is missing: ${path.basename(this.binary)}.`);
    const child = spawn(this.binary, ["--state-dir", this.stateDir], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    this.child = child;
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.child !== child) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!message.id) {
        if (typeof message.event === "string") this.onEvent(message);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      this.onDiagnostic({
        method: request.method,
        durationMs: Date.now() - request.started,
        outcome: message.error ? "error" : "ok",
        code: message.error?.code,
        ...(typeof message.result?.connected === "boolean"
          ? { connected: message.result.connected }
          : {}),
        ...(typeof message.result?.configured === "boolean"
          ? { configured: message.result.configured }
          : {}),
        ...(typeof message.result?.loginPending === "boolean"
          ? { loginPending: message.result.loginPending }
          : {}),
        ...(Array.isArray(message.result) ? { count: message.result.length } : {}),
      });
      if (message.error)
        request.reject(new Error(message.error.message || "Channel request failed."));
      else request.resolve(message.result);
    });
    // Authentication and protocol details must not be copied into app logs.
    child.stderr.resume();
    const fail = (error) => {
      if (this.child !== child) return;
      this.child = null;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    child.stdin.on("error", fail);
    child.once("error", fail);
    child.once("exit", (code, signal) =>
      fail(new Error(`Channel component stopped (${signal || code}).`)),
    );
    return child;
  }

  request(method, params, timeoutMs = 15000) {
    const child = this.ensureStarted();
    const id = `desktop-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.onDiagnostic({ method, durationMs: Date.now() - started, outcome: "timeout" });
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, started });
      child.stdin.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
        (error) => {
          if (!error) return;
          const request = this.pending.get(id);
          if (!request) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  close() {
    if (this.child && !this.child.stdin.destroyed) this.child.stdin.end();
    this.child?.kill("SIGTERM");
  }
}

async function sqliteRows(database, sql) {
  const { stdout } = await execFileAsync(
    "/usr/bin/sqlite3",
    ["-readonly", "-json", database, sql],
    {
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  return stdout.trim() ? JSON.parse(stdout) : [];
}

class LocalChannels {
  constructor(binaryDir, stateDir, onEvent = () => {}, options = {}) {
    this._googleMessages = null;
    this.cancelGoogleSignIn = options.googleCancelSignIn;
    this.createGoogleMessages = () =>
      new GoogleMessagesLocal(
        binaryDir,
        stateDir,
        options.secureStorage || { isEncryptionAvailable: () => false },
        options.googleSignIn,
      );
    const hooks = (service) => ({
      onEvent: (message) => {
        if (["login.completed", "connection.ready", "connection.status"].includes(message.event))
          this.invalidateConversations(service);
        // Message contents only travel to the inbox; diagnostics contain no content or credentials.
        if (/^(connection\.|login\.|message\.)/.test(message.event))
          onEvent({ service, ...message });
      },
      onDiagnostic: (diagnostic) => {
        try {
          const file = path.join(stateDir, "channel-health.jsonl");
          if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024)
            fs.renameSync(file, `${file}.previous`);
          fs.appendFileSync(
            file,
            `${JSON.stringify({ at: new Date().toISOString(), service, ...diagnostic })}\n`,
            { mode: 0o600 },
          );
        } catch {
          /* Diagnostics must not interrupt a chat connection. */
        }
      },
    });
    this.clients = {
      discord: new Sidecar(
        path.join(binaryDir, "ditto-discord-sidecar"),
        stateDir,
        hooks("discord"),
      ),
      telegram: new Sidecar(
        path.join(binaryDir, "ditto-telegram-sidecar"),
        stateDir,
        hooks("telegram"),
      ),
    };
    this.imessageDatabase = path.join(os.homedir(), "Library", "Messages", "chat.db");
    this.cache = new Map();
    this.conversationVersions = new Map();
    this.telegramRestore = null;
    this.telegramRestoreSettled = false;
    this.telegramRestoreChild = null;
    this.statusRequests = new Map();
    this.loginCodes = new Map();
  }

  get googleMessages() {
    return (this._googleMessages ||= this.createGoogleMessages());
  }

  sidecar(service) {
    if (!["discord", "telegram"].includes(service))
      throw new Error("Unsupported local chat service.");
    return this.clients[service];
  }

  async status(service) {
    if (this.statusRequests.has(service)) return this.statusRequests.get(service);
    const request = this.readStatus(service).then(async (result) => {
      if (result.loginPending) {
        const code = this.loginCodes.get(service);
        if (!result.qrUrl && code && Date.now() < code.expiresAt) {
          result = {
            ...result,
            qrUrl: code.qrUrl,
            qrExpiresAt: new Date(code.expiresAt).toISOString(),
          };
        }
      } else this.loginCodes.delete(service);
      if (result.qrUrl)
        result.qrDataUrl = await QRCode.toDataURL(result.qrUrl, { width: 220, margin: 1 });
      return result;
    });
    this.statusRequests.set(service, request);
    try {
      return await request;
    } finally {
      this.statusRequests.delete(service);
    }
  }

  async readStatus(service) {
    if (service === "googlemessages") return this.googleMessages.status();
    if (service === "imessage") {
      try {
        await sqliteRows(this.imessageDatabase, "SELECT COUNT(*) AS count FROM chat LIMIT 1");
        return { connected: true, detail: "Messages on this Mac is available." };
      } catch {
        return {
          connected: false,
          detail: "Give Ditto Desktop Full Disk Access to read Messages history.",
        };
      }
    }
    const client = this.sidecar(service);
    if (service === "discord") {
      const current = await client.request("status");
      return current.connected || current.loginPending
        ? current
        : client.request("connection.restore", undefined, 30000);
    }
    const current = await client.request("status");
    // A replacement component starts disconnected even when its saved session remains valid.
    if (this.telegramRestoreChild !== client.child) {
      this.telegramRestoreChild = client.child;
      this.telegramRestore = null;
      this.telegramRestoreSettled = false;
    }
    if (
      current.configured === false ||
      current.connected ||
      current.loginPending ||
      this.telegramRestoreSettled
    )
      return current;
    if (!this.telegramRestore) {
      const child = client.child;
      this.telegramRestore = client
        .request("connection.restore", undefined, 30000)
        .catch(() => null)
        .finally(() => {
          if (this.telegramRestoreChild === child) this.telegramRestoreSettled = true;
        });
    }
    return { ...current, restoring: true, detail: "Checking saved Telegram sign-in…" };
  }

  async startLogin(service, method) {
    if (service === "googlemessages") return this.googleMessages.login(method);
    const client = this.sidecar(service);
    this.invalidateConversations(service);
    const current = await client.request("status");
    if (current.configured === false)
      throw new Error(
        "Telegram is unavailable in this build. Ditto’s Telegram app credentials need to be added before you can sign in.",
      );
    if (service === "discord") {
      const status = await client.request("status");
      if (status.loginPending) await client.request("login.cancel");
    }
    const result = await client.request("login.start", undefined, 30000);
    if (!result.connected && result.qrUrl) {
      this.loginCodes.set(service, {
        qrUrl: result.qrUrl,
        expiresAt: Date.now() + (result.expiresInSeconds || 180) * 1000,
      });
      result.qrDataUrl = await QRCode.toDataURL(result.qrUrl, { width: 220, margin: 1 });
    }
    return result;
  }

  async cancelLogin(service) {
    if (service === "googlemessages") {
      this.cancelGoogleSignIn?.();
      this.googleMessages.cancelLogin();
      return this.googleMessages.status();
    }
    if (service === "discord") {
      this.loginCodes.delete(service);
      return this.sidecar(service).request("login.cancel");
    }
    throw new Error("Use Disconnect to end this sign-in attempt.");
  }

  async logout(service) {
    if (service === "googlemessages") return this.googleMessages.logout();
    this.invalidateConversations(service);
    this.loginCodes.delete(service);
    return this.sidecar(service).request("logout");
  }

  invalidateConversations(service) {
    this.cache.delete(service);
    this.conversationVersions.set(service, (this.conversationVersions.get(service) || 0) + 1);
  }

  async conversations(service) {
    if (service === "googlemessages") return this.googleMessages.conversations();
    const cached = this.cache.get(service);
    if (cached && Date.now() - cached.at < 15000) return cached.value;
    const version = this.conversationVersions.get(service);
    let value;
    if (service === "imessage") {
      const rows = await sqliteRows(
        this.imessageDatabase,
        `SELECT c.ROWID AS id, c.display_name, c.chat_identifier, c.style, h.id AS handle,
        datetime(MAX(m.date)/1000000000 + 978307200, 'unixepoch') AS latest_message_at
        FROM chat c LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
        LEFT JOIN handle h ON h.ROWID = chj.handle_id
        LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
        LEFT JOIN message m ON m.ROWID = cmj.message_id
        GROUP BY c.ROWID ORDER BY MAX(m.date) DESC LIMIT 200`,
      );
      value = rows.map((row) => ({
        id: String(row.id),
        title: row.display_name || row.handle || row.chat_identifier || `Conversation ${row.id}`,
        kind: row.style === 43 ? "group" : "direct",
        latestMessageAt: row.latest_message_at,
        handle: row.handle || row.chat_identifier || null,
      }));
    } else value = await this.sidecar(service).request("conversations.list", undefined, 60000);
    // A response from before Disconnect/sign-in must not refill the next account's cache.
    if (version !== this.conversationVersions.get(service))
      throw new Error("Chat connection changed. Refresh the conversation list.");
    this.cache.set(service, { at: Date.now(), value });
    return value;
  }

  async messages(service, conversationId, limit = 80, beforeId = "") {
    if (service === "googlemessages")
      return this.googleMessages.messages(
        conversationId,
        Math.max(1, Math.min(200, Math.trunc(limit))),
        beforeId,
      );
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    if (service === "imessage") {
      if (!/^\d+$/.test(conversationId)) throw new Error("Invalid iMessage conversation.");
      const rows = await sqliteRows(
        this.imessageDatabase,
        `SELECT m.ROWID AS id,m.text,m.is_from_me,h.id AS handle,
        CASE WHEN length(m.text)>0 THEN NULL ELSE hex(m.attributedBody) END AS attributed_body,
        datetime(m.date/1000000000 + 978307200, 'unixepoch') AS timestamp
        FROM message m JOIN chat_message_join cmj ON cmj.message_id=m.ROWID
        LEFT JOIN handle h ON h.ROWID=m.handle_id WHERE cmj.chat_id=${conversationId}
        ORDER BY m.date DESC LIMIT ${safeLimit}`,
      );
      return rows.reverse().map((row) => ({
        id: String(row.id),
        channelId: conversationId,
        content: imessageText(row.text, row.attributed_body),
        timestamp: row.timestamp,
        author: {
          displayName: row.is_from_me ? "You" : row.handle || "Unknown",
          isSelf: Boolean(row.is_from_me),
        },
        attachments: [],
      }));
    }
    return this.sidecar(service).request(
      "messages.list",
      { channelId: conversationId, limit: safeLimit, ...(beforeId ? { beforeId } : {}) },
      90000,
    );
  }

  async send(service, conversationId, content, handle) {
    if (typeof content !== "string" || !content.trim() || content.length > 8000)
      throw new Error("Enter a message under 8,000 characters.");
    if (service === "googlemessages") return this.googleMessages.send(conversationId, content);
    if (service === "imessage") {
      if (!/^\d+$/.test(conversationId)) throw new Error("Invalid iMessage conversation.");
      // Recheck the database rather than trusting a renderer's cached recipient.
      // Group chats and ambiguous recipients must stay read-only at the IPC boundary.
      const [destination] = await sqliteRows(
        this.imessageDatabase,
        `SELECT c.style, COUNT(DISTINCT h.id) AS recipient_count, MAX(h.id) AS handle
        FROM chat c LEFT JOIN chat_handle_join chj ON chj.chat_id=c.ROWID
        LEFT JOIN handle h ON h.ROWID=chj.handle_id
        WHERE c.ROWID=${conversationId} GROUP BY c.ROWID`,
      );
      if (!destination || destination.style !== 45 || destination.recipient_count !== 1)
        throw new Error("This iMessage conversation is read-only on this Mac.");
      if (handle !== destination.handle)
        throw new Error("This iMessage chat needs a verified recipient. Refresh the conversation.");
      handle = destination.handle;
      if (!handle || !/^\+?[\d@.a-zA-Z_-]{3,100}$/.test(handle))
        throw new Error("This iMessage chat needs a verified phone number or email to send.");
      const script =
        'on run argv\nset targetHandle to item 1 of argv\nset messageText to item 2 of argv\ntell application "Messages"\nset targetService to first service whose service type = iMessage\nset targetBuddy to buddy targetHandle of targetService\nsend messageText to targetBuddy\nend tell\nend run';
      await execFileAsync("/usr/bin/osascript", ["-e", script, "--", handle, content], {
        timeout: 30000,
      });
      return {
        id: `local:${Date.now()}`,
        content,
        timestamp: new Date().toISOString(),
        author: { displayName: "You", isSelf: true },
        attachments: [],
      };
    }
    const params = { channelId: conversationId, content, idempotencyKey: crypto.randomUUID() };
    return this.sidecar(service).request("message.send", params, 90000);
  }

  close() {
    this._googleMessages?.close();
    for (const client of Object.values(this.clients)) client.close();
  }
}

module.exports = { LocalChannels };
