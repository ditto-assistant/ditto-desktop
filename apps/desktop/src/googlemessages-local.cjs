const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const QRCode = require("qrcode");

class GoogleMessagesLocal {
  constructor(binaryDir, directory, secureStorage, signIn) {
    this.binary = path.join(binaryDir, "ditto-google-messages-bridge");
    this.directory = directory;
    this.secureStorage = secureStorage;
    this.signIn = signIn;
    this.child = null;
    this.starting = null;
    this.refreshing = null;
    this.flow = null;
    this.pairGeneration = 0;
    this.token = crypto.randomBytes(32).toString("hex");
    this.db = new DatabaseSync(path.join(directory, "google-messages.sqlite"));
    fs.chmodSync(path.join(directory, "google-messages.sqlite"), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(account TEXT,conversation TEXT,id TEXT,value TEXT,timestamp TEXT,PRIMARY KEY(account,conversation,id));
      CREATE TABLE IF NOT EXISTS conversations(account TEXT,id TEXT,value TEXT,PRIMARY KEY(account,id));`);
    this.account = null;
    try {
      if (secureStorage.isEncryptionAvailable())
        this.account = JSON.parse(secureStorage.decryptString(fs.readFileSync(this.accountFile())));
    } catch {
      /* A missing or revoked session stays disconnected. */
    }
  }
  accountFile() {
    return path.join(this.directory, "google-messages-session.enc");
  }
  async start() {
    if (this.child && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (!fs.existsSync(this.binary))
        throw new Error("The Google Messages local component is missing from this build.");
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = server.address().port;
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      this.base = `http://127.0.0.1:${port}`;
      const child = spawn(this.binary, [], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          BIND_HOST: "127.0.0.1",
          PORT: String(port),
          BRIDGE_TOKEN: this.token,
          LOG_LEVEL: "error",
        },
        stdio: "ignore",
      });
      this.child = child;
      let spawnError;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("exit", () => {
        if (this.child === child) this.child = null;
      });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (spawnError || child.exitCode !== null)
          throw new Error("Google Messages could not start its local transport.");
        try {
          if ((await fetch(this.base + "/health", { signal: AbortSignal.timeout(500) })).ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      child.kill("SIGTERM");
      throw new Error("Google Messages local transport did not become ready.");
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }
  async request(route, body) {
    await this.start();
    const response = await fetch(this.base + route, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok)
      throw new Error(
        "Google Messages could not connect. Check that your Android phone is online, or reconnect this Mac.",
      );
    const text = await response.text();
    if (text.length > 16 * 1024 * 1024)
      throw new Error("Google Messages returned too much history in one page.");
    return JSON.parse(text);
  }
  async status() {
    if (this.flow) await this.pair({ flowID: this.flow.state.flowID });
    return {
      connected: !!this.account,
      configured: fs.existsSync(this.binary),
      loginPending: !!this.flow,
      ...(this.account
        ? { user: { id: this.account.syncId || undefined, displayName: this.account.displayName } }
        : {}),
      detail: this.account
        ? "Google Messages is connected on this Mac."
        : this.flow?.detail ||
          "Pair your Android phone with this Mac. Chat history stays local until you enable cloud sync.",
      ...(this.flow?.qrDataUrl ? { qrDataUrl: this.flow.qrDataUrl } : {}),
      expiresInSeconds: 300,
    };
  }
  async login(method = "qr") {
    const generation = ++this.pairGeneration;
    this.flow = null;
    if (!this.secureStorage.isEncryptionAvailable())
      throw new Error(
        "Unlock your Mac’s secure credential storage before pairing Google Messages.",
      );
    let credentials = { method: "qr" };
    if (method === "google") {
      const outcome = await this.signIn();
      if (outcome.status !== "cookies")
        throw new Error(
          "Google Messages sign-in was cancelled. You can try again or use QR pairing.",
        );
      credentials = { method: "google", cookies: JSON.stringify(outcome.cookies) };
    }
    if (generation !== this.pairGeneration) return this.status();
    await this.pair(credentials, generation);
    return this.status();
  }
  async pair(credentials, generation = this.pairGeneration) {
    const result = await this.request("/v1/connect", { credentials });
    if (generation !== this.pairGeneration) return;
    if (result.credentials?.session) {
      const account = {
        id: crypto.randomUUID(),
        syncId: result.displayName
          ? crypto
              .createHash("sha256")
              .update("googlemessages\0" + result.displayName.trim())
              .digest("hex")
          : "",
        displayName: result.displayName || "Google Messages",
        credentials: result.credentials,
      };
      const temp = this.accountFile() + ".tmp";
      fs.writeFileSync(temp, this.secureStorage.encryptString(JSON.stringify(account)), {
        mode: 0o600,
      });
      fs.renameSync(temp, this.accountFile());
      this.account = account;
      this.flow = null;
    } else if (result.challenge) {
      const challenge = result.challenge;
      this.flow = {
        ...challenge,
        detail:
          challenge.kind === "emoji"
            ? `Confirm ${challenge.prompt} in Google Messages on your Android phone.`
            : "Google Messages → profile → Device pairing → Scan QR code",
        qrDataUrl:
          challenge.kind === "qr"
            ? await QRCode.toDataURL(challenge.prompt, { width: 220, margin: 1 })
            : "",
      };
    } else throw new Error("Google Messages returned an incomplete pairing response.");
  }
  async refresh() {
    if (!this.account) throw new Error("Pair Google Messages on this Mac first.");
    if (this.refreshing) return this.refreshing;
    const account = this.account;
    this.refreshing = (async () => {
      const cursor =
        this.db.prepare("SELECT value FROM state WHERE key=?").get(account.id)?.value || "";
      const page = await this.request("/v1/sync", {
        credentials: account.credentials,
        cursor,
        limit: 500,
      });
      if (this.account !== account) return;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of page.threads || [])
          this.db.prepare("INSERT OR REPLACE INTO conversations VALUES(?,?,?)").run(
            account.id,
            row.threadId,
            JSON.stringify({
              id: row.threadId,
              title: row.threadName,
              kind: row.threadKind,
              latestMessageAt: row.lastMessageAt,
            }),
          );
        for (const row of page.messages || []) {
          const message = {
            id: row.messageId,
            channelId: row.threadId,
            content: row.text,
            timestamp: row.timestamp,
            author: { id: row.senderId, displayName: row.senderName, isSelf: row.isFromSelf },
            attachments: (row.attachments || []).map((a) => ({
              filename: a.name,
              contentType: a.type === "file" ? "application/octet-stream" : a.type + "/unknown",
              url: a.url,
            })),
          };
          this.db
            .prepare("INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?)")
            .run(account.id, row.threadId, row.messageId, JSON.stringify(message), row.timestamp);
          this.db.prepare("INSERT OR IGNORE INTO conversations VALUES(?,?,?)").run(
            account.id,
            row.threadId,
            JSON.stringify({
              id: row.threadId,
              title: row.threadName,
              kind: row.threadKind,
              latestMessageAt: row.timestamp,
            }),
          );
        }
        this.db
          .prepare("INSERT OR REPLACE INTO state VALUES(?,?)")
          .run(account.id, page.nextCursor || cursor);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }
  async conversations() {
    await this.refresh();
    return this.db
      .prepare("SELECT value FROM conversations WHERE account=?")
      .all(this.account.id)
      .map((r) => JSON.parse(r.value));
  }
  async messages(id, limit = 100, before = "") {
    await this.refresh();
    const rows = this.db
      .prepare(
        "SELECT value FROM messages WHERE account=? AND conversation=? ORDER BY timestamp DESC,id DESC",
      )
      .all(this.account.id, id)
      .map((r) => JSON.parse(r.value));
    const start = before ? rows.findIndex((r) => r.id === before) + 1 : 0;
    return rows.slice(start, start + limit).toReversed();
  }
  async send(id, text) {
    if (!this.account) throw new Error("Pair Google Messages on this Mac first.");
    const result = await this.request("/v1/send", {
      credentials: this.account.credentials,
      threadId: id,
      text,
    });
    return result.message;
  }
  cancelLogin() {
    ++this.pairGeneration;
    this.flow = null;
    this.child?.kill("SIGTERM");
    this.child = null;
  }
  async logout() {
    this.cancelLogin();
    this.account = null;
    this.flow = null;
    fs.rmSync(this.accountFile(), { force: true });
    this.db.exec("DELETE FROM messages;DELETE FROM conversations;DELETE FROM state;");
    this.child?.kill("SIGTERM");
  }
  close() {
    this.child?.kill("SIGTERM");
    this.db.close();
  }
}
module.exports = { GoogleMessagesLocal };
