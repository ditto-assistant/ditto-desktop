const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const CONSENT_VERSION = "2026-10-desktop-chat-v1";
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const allowed = (provider) => ["discord", "googlemessages"].includes(provider);
function normalizedMessage(conversation, message) {
  if (!message.id || !Number.isFinite(Date.parse(message.timestamp)))
    throw new Error("A local message has no stable identity or timestamp.");
  const attachments = (message.attachments || []).map((a) => ({
    type: ["image", "audio", "video"].includes(a.contentType?.split("/")[0])
      ? a.contentType.split("/")[0]
      : "file",
    name: a.filename || "Attachment",
    url: a.url || "",
  }));
  if (attachments.some((a) => !/^https:\/\//i.test(a.url)))
    throw new Error("This conversation has an attachment that cannot yet sync securely.");
  return {
    threadId: conversation.id,
    threadName: conversation.title,
    threadKind: conversation.kind === "direct" ? "dm" : conversation.kind,
    messageId: String(message.id),
    timestamp: new Date(message.timestamp).toISOString(),
    ...(message.editedAt ? { editedAt: new Date(message.editedAt).toISOString() } : {}),
    text: message.content || "",
    senderId: message.author?.id || "",
    senderName: message.author?.displayName || "",
    isFromSelf: message.author?.isSelf === true,
    ...(message.replyToId ? { replyToMessageId: String(message.replyToId) } : {}),
    attachments,
  };
}

// The queue contains selected chat data, never provider credentials or Ditto tokens.
// A page and its exact checkpoint survive restart until the server acknowledges it.
class DesktopChatSync {
  constructor(directory, channels) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "chat-sync.sqlite");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delivered(source TEXT,conversation TEXT,id TEXT,fingerprint TEXT,
        PRIMARY KEY(source,conversation,id));`);
    const device = this.db.prepare("SELECT value FROM settings WHERE key='device'").get();
    this.device = device?.value || crypto.randomUUID();
    this.db.prepare("INSERT OR IGNORE INTO settings VALUES('device',?)").run(this.device);
    this.channels = channels;
    this.preparing = null;
  }
  all(uid) {
    if (typeof uid !== "string" || !uid || uid.length > 256)
      throw new Error("Sign in with Ditto first.");
    return this.db
      .prepare("SELECT value FROM sources")
      .all()
      .map((r) => JSON.parse(r.value))
      .filter((s) => s.uid === uid);
  }
  save(source) {
    this.db
      .prepare("INSERT OR REPLACE INTO sources VALUES(?,?)")
      .run(source.key, JSON.stringify(source));
  }
  get(uid, key) {
    return this.all(uid).find((s) => s.key === key);
  }
  status(uid) {
    return this.all(uid).map(({ key, provider, accountId, chats, error, lastSynced, pending }) => ({
      key,
      provider,
      accountId,
      chats: chats.map(({ id, enabled, complete }) => ({ id, enabled, complete })),
      error: error || "",
      lastSynced: lastSynced || "",
      queued: !!pending && !pending.cancelled,
    }));
  }
  async select(uid, provider, conversationId, enabled) {
    if (!allowed(provider) || typeof enabled !== "boolean")
      throw new Error("Unsupported chat sync selection.");
    this.all(uid);
    const status = await this.channels.status(provider);
    if (!status.connected || !status.user?.id)
      throw new Error("Connect this chat account on this Mac first.");
    const key = digest([uid, provider, status.user.id]);
    const source = this.get(uid, key) || {
      key,
      uid,
      provider,
      accountId: status.user.id,
      displayName: status.user.displayName || "",
      cursor: "",
      sourceId: "",
      chats: [],
      next: 0,
    };
    let chat = source.chats.find((c) => c.id === conversationId);
    if (!chat) {
      if (!enabled) return this.status(uid);
      const conversation = (await this.channels.conversations(provider)).find(
        (c) => c.id === conversationId,
      );
      if (!conversation) throw new Error("This conversation is no longer available.");
      chat = {
        id: conversation.id,
        title: conversation.title,
        kind: conversation.kind,
        enabled: false,
        before: "",
        complete: false,
      };
      source.chats.push(chat);
    }
    chat.enabled = enabled;
    source.error = "";
    if (!enabled && source.pending?.conversation === conversationId)
      source.pending.cancelled = true;
    // Re-registering explicitly resumes server consent without discarding its receipt.
    source.needsRegistration = true;
    this.save(source);
    return this.status(uid);
  }
  async prepare(uid) {
    if (this.preparing) return null;
    this.preparing = this.prepareOne(uid);
    try {
      return await this.preparing;
    } finally {
      this.preparing = null;
    }
  }
  async prepareOne(uid) {
    const sources = this.all(uid).sort((a, b) => (a.lastAttempt || 0) - (b.lastAttempt || 0));
    for (let source of sources) {
      try {
        const enabled = source.chats.filter((c) => c.enabled);
        if (!enabled.length) {
          if (source.needsRegistration && source.sourceId)
            return {
              kind: "pause",
              key: source.key,
              provider: source.provider,
              sourceId: source.sourceId,
            };
          continue;
        }
        const status = await this.channels.status(source.provider);
        if (!status.connected || status.user?.id !== source.accountId) continue;
        source = this.get(uid, source.key);
        if (!source || !source.chats.some((c) => c.enabled)) continue;
        if (!source.sourceId || source.needsRegistration)
          return {
            kind: "register",
            key: source.key,
            provider: source.provider,
            registration: {
              accountId: source.accountId,
              deviceId: this.device,
              displayName: source.displayName,
              consentVersion: CONSENT_VERSION,
            },
          };
        if (source.pending)
          return {
            kind: "ingest",
            key: source.key,
            provider: source.provider,
            sourceId: source.sourceId,
            batch: source.pending.batch,
          };
        const currentEnabled = source.chats.filter((c) => c.enabled);
        const conversation = currentEnabled[source.next % currentEnabled.length];
        const rows = await this.channels.messages(
          source.provider,
          conversation.id,
          100,
          conversation.before,
        );
        // Recheck consent and identity after asynchronous provider work.
        const current = this.get(uid, source.key);
        const currentChat = current?.chats.find((c) => c.id === conversation.id);
        const currentStatus = await this.channels.status(source.provider);
        if (!currentChat?.enabled || currentStatus.user?.id !== source.accountId) continue;
        const messages = rows
          .filter((m) => m.content?.trim() || m.attachments?.length)
          .map((m) => normalizedMessage(conversation, m));
        const changed = messages.filter(
          (m) =>
            this.db
              .prepare(
                "SELECT fingerprint FROM delivered WHERE source=? AND conversation=? AND id=?",
              )
              .get(source.key, conversation.id, m.messageId)?.fingerprint !== digest(m),
        );
        // Discord pagination uses the oldest snowflake, independent of presentation order.
        const oldest =
          [...rows].sort(
            (a, b) =>
              Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
              String(a.id).localeCompare(String(b.id)),
          )[0]?.id || "";
        const hasKnown = messages.some((message) =>
          this.db
            .prepare("SELECT 1 FROM delivered WHERE source=? AND conversation=? AND id=?")
            .get(source.key, conversation.id, message.messageId),
        );
        const keepPaging =
          rows.length === 100 &&
          (source.provider === "googlemessages" || !currentChat.complete || !hasKnown);
        const progress = {
          before: keepPaging ? oldest : "",
          complete: currentChat.complete || rows.length < 100,
        };
        current.lastAttempt = Date.now();
        current.next = (source.next || 0) + 1;
        if (!changed.length) {
          Object.assign(currentChat, progress);
          this.save(current);
          continue;
        }
        current.pending = {
          conversation: conversation.id,
          progress,
          batch: { previousCursor: current.cursor, cursor: crypto.randomUUID(), messages: changed },
        };
        this.save(current);
        return {
          kind: "ingest",
          key: current.key,
          provider: current.provider,
          sourceId: current.sourceId,
          batch: current.pending.batch,
        };
      } catch {
        // A disconnected or malformed local source must not starve other
        // selected accounts. Persist safe status, never provider diagnostics.
        this.failed(uid, source.key);
      }
    }
    return null;
  }
  registered(uid, key, receipt) {
    const source = this.get(uid, key);
    if (!source || typeof receipt?.sourceId !== "string" || typeof receipt.cursor !== "string")
      throw new Error("Invalid cloud sync receipt.");
    if (source.pending && receipt.cursor === source.pending.batch.cursor)
      this.acknowledge(uid, key, receipt);
    else if (receipt.cursor !== source.cursor)
      throw new Error("Cloud sync checkpoint differs from this Mac. Pause sync and reconnect.");
    if (source.pending?.cancelled && receipt.cursor === source.cursor) {
      source.pending = null;
      this.save(source);
    }
    const fresh = this.get(uid, key);
    fresh.sourceId = receipt.sourceId;
    fresh.needsRegistration = false;
    fresh.error = "";
    fresh.lastAttempt = Date.now();
    this.save(fresh);
  }
  acknowledge(uid, key, receipt) {
    const source = this.get(uid, key);
    if (
      !source?.pending ||
      receipt?.sourceId !== source.sourceId ||
      receipt?.cursor !== source.pending.batch.cursor
    )
      throw new Error("Cloud did not acknowledge the queued page.");
    const pending = source.pending;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const message of pending.batch.messages)
        this.db
          .prepare("INSERT OR REPLACE INTO delivered VALUES(?,?,?,?)")
          .run(key, pending.conversation, message.messageId, digest(message));
      const chat = source.chats.find((c) => c.id === pending.conversation);
      Object.assign(chat, pending.progress);
      source.cursor = receipt.cursor;
      source.pending = null;
      source.lastSynced = new Date().toISOString();
      source.error = "";
      this.save(source);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  paused(uid, key) {
    const source = this.get(uid, key);
    if (source) {
      source.needsRegistration = false;
      this.save(source);
    }
  }
  failed(uid, key) {
    const source = this.get(uid, key);
    if (source) {
      source.error =
        "Cloud sync is waiting. Your local chats and queued page are safe. Retry when the service is available.";
      source.lastAttempt = Date.now();
      this.save(source);
    }
  }
  close() {
    this.db.close();
  }
}
module.exports = { DesktopChatSync };
