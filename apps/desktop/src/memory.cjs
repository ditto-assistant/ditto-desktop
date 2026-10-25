const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");
const yazl = require("yazl");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

const execFileAsync = promisify(execFile);
const CODE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cjs",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
  ".zsh",
]);
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".venv",
  "venv",
  ".t3",
  ".codex",
  ".cursor",
]);
const SKIP_NAMES =
  /(^\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|(^|[-_.])(secret|credential|token)([-_.]|$)|(^package-lock|^pnpm-lock|^yarn\.lock$))/i;
const MAX_CODE_BYTES = 512 * 1024;
const CHUNK_CHARS = 12000;

function redact(text) {
  return String(text)
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
      "[private key removed]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|ditto_mcp_[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b/g,
      "[credential removed]",
    )
    .replace(
      /((?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?)[^\s"',;]{12,}/gi,
      "$1[credential removed]",
    );
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        ["text", "input_text", "output_text"].includes(item.type),
    )
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("\n");
}

function parseTrajectoryLine(source, line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (source === "codex") {
    if (record.type !== "response_item" || record.payload?.type !== "message") return null;
    const role = record.payload.role;
    if (role !== "user" && role !== "assistant") return null;
    const text = textFromContent(record.payload.content).trim();
    return text ? { role, text, timestamp: record.timestamp || null } : null;
  }
  if (source === "cursor") {
    const role = record.role;
    if (role !== "user" && role !== "assistant") return null;
    const text = textFromContent(record.message?.content).trim();
    return text
      ? { role, text, timestamp: record.timestamp || record.message?.timestamp || null }
      : null;
  }
  return null;
}

async function* filesBelow(root, predicate) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) || root.includes(".codex") || root.includes(".cursor")) {
        yield* filesBelow(full, predicate);
      }
    } else if (entry.isFile() && predicate(full)) {
      yield full;
    }
  }
}

async function discoverRepos(roots) {
  const repos = new Set();
  async function visit(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      repos.add(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        await visit(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  for (const root of roots) await visit(root, 0);
  return [...repos].sort();
}

function isCodeFile(name) {
  const base = path.basename(name);
  return (
    !SKIP_NAMES.test(base) &&
    (CODE_EXTENSIONS.has(path.extname(base).toLowerCase()) ||
      ["Dockerfile", "Makefile", "Justfile", "AGENTS.md", "README"].includes(base))
  );
}

function defaultCodeRoots() {
  const home = os.homedir();
  return [
    path.join(home, "code"),
    path.join(home, "Documents", "ChatGPT"),
    path.join(home, "Documents", "Codex"),
    path.join(home, "heyditto-stack"),
    path.join(home, "aiq"),
  ];
}

class MemoryStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = dataDir;
    this.db = new DatabaseSync(path.join(dataDir, "local-memory.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS docs (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        path TEXT NOT NULL,
        part INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        digest TEXT NOT NULL,
        modified_at TEXT,
        indexed_at TEXT NOT NULL,
        UNIQUE(source, path, part)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(title, body, content='docs', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
        INSERT INTO docs_fts(rowid,title,body) VALUES(new.id,new.title,new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
        INSERT INTO docs_fts(docs_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body);
        INSERT INTO docs_fts(rowid,title,body) VALUES(new.id,new.title,new.body);
      END;
      CREATE TABLE IF NOT EXISTS harness_synced (doc_id INTEGER PRIMARY KEY, synced_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS docs_harness_edit AFTER UPDATE ON docs
      WHEN new.source IN ('codex','cursor') AND old.digest<>new.digest BEGIN
        -- A receipt belongs to the full turn, including its prompt and progress.
        -- Invalidate only the edited turn; retain unchanged neighboring receipts.
        DELETE FROM harness_synced WHERE doc_id IN (
          SELECT id FROM docs WHERE source=new.source AND path=new.path
          AND part>=COALESCE((SELECT MAX(part) FROM docs
            WHERE source=new.source AND path=new.path AND role='user' AND part<=new.part),new.part)
          AND part<COALESCE((SELECT MIN(part) FROM docs
            WHERE source=new.source AND path=new.path AND role='user' AND part>new.part),2147483647)
        );
      END;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scan_files (
        source TEXT NOT NULL, path TEXT NOT NULL, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
        PRIMARY KEY(source,path)
      );
      CREATE TABLE IF NOT EXISTS pi_runs (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        workspace TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS code_threads (
        id TEXT PRIMARY KEY,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0
      );
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(pi_runs)")
        .all()
        .some((column) => column.name === "provider")
    ) {
      this.db.exec("ALTER TABLE pi_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'pi'");
    }
    if (
      !this.db
        .prepare("PRAGMA table_info(pi_runs)")
        .all()
        .some((column) => column.name === "session_id")
    ) {
      this.db.exec("ALTER TABLE pi_runs ADD COLUMN session_id TEXT");
    }
    this.upsert = this.db
      .prepare(`INSERT INTO docs(source,path,part,role,title,body,digest,modified_at,indexed_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source,path,part) DO UPDATE SET
      role=excluded.role,title=excluded.title,body=excluded.body,digest=excluded.digest,
      modified_at=excluded.modified_at,indexed_at=excluded.indexed_at
      WHERE docs.digest<>excluded.digest`);
    this.getDigest = this.db.prepare(
      "SELECT digest FROM docs WHERE source=? AND path=? AND part=?",
    );
    this.getScannedFile = this.db.prepare(
      "SELECT mtime_ms,size FROM scan_files WHERE source=? AND path=?",
    );
    this.putScannedFile = this.db
      .prepare(`INSERT INTO scan_files(source,path,mtime_ms,size) VALUES(?,?,?,?)
      ON CONFLICT(source,path) DO UPDATE SET mtime_ms=excluded.mtime_ms,size=excluded.size`);
  }

  close() {
    this.db.close();
  }

  startPiRun(workspace, prompt, provider = "pi", sessionId = null) {
    return Number(
      this.db
        .prepare(
          "INSERT INTO pi_runs(started_at,workspace,prompt,status,provider,session_id) VALUES(?,?,?,?,?,?)",
        )
        .run(new Date().toISOString(), workspace, prompt, "running", provider, sessionId ?? null)
        .lastInsertRowid,
    );
  }

  finishPiRun(id, status, response, error = "") {
    this.db
      .prepare("UPDATE pi_runs SET finished_at=?,status=?,response=?,error=? WHERE id=?")
      .run(new Date().toISOString(), status, response, error, id);
  }

  recentPiRuns(limit = 20) {
    return this.db
      .prepare(
        "SELECT id,started_at,finished_at,workspace,prompt,response,status,error,provider,session_id FROM pi_runs ORDER BY id DESC LIMIT ?",
      )
      .all(Math.max(1, Math.min(100, limit)));
  }

  codeThreads() {
    return this.db
      .prepare(`
      WITH runs AS (
        SELECT *, CASE WHEN session_id IS NOT NULL THEN 'session:' || session_id ELSE 'run:' || id END AS thread_id
        FROM pi_runs
      ), latest AS (SELECT thread_id, MAX(id) AS id, MIN(id) AS first_id FROM runs GROUP BY thread_id)
      SELECT r.id, r.started_at, r.workspace, r.provider, r.status, r.session_id, r.thread_id AS threadId, first.prompt AS title,
        COALESCE(t.pinned, 0) AS pinned, COALESCE(t.archived, 0) AS archived
      FROM latest l JOIN runs r ON r.id=l.id JOIN runs first ON first.id=l.first_id
      LEFT JOIN code_threads t ON t.id=r.thread_id
      ORDER BY pinned DESC, r.id DESC
    `)
      .all();
  }

  codeThreadRuns(id) {
    if (typeof id !== "string") throw new Error("Invalid Code conversation.");
    if (id.startsWith("session:"))
      return this.db
        .prepare("SELECT * FROM pi_runs WHERE session_id=? ORDER BY id")
        .all(id.slice(8));
    if (/^run:\d+$/.test(id))
      return this.db
        .prepare("SELECT * FROM pi_runs WHERE id=? AND session_id IS NULL")
        .all(Number(id.slice(4)));
    return [];
  }

  updateCodeThread(id, patch) {
    if (!this.codeThreadRuns(id).length) throw new Error("Code conversation not found.");
    if (
      !patch ||
      !["pinned", "archived"].some((field) => typeof patch[field] === "boolean") ||
      ["pinned", "archived"].some(
        (field) => patch[field] !== undefined && typeof patch[field] !== "boolean",
      )
    )
      throw new Error("Invalid Code conversation update.");
    const current = this.db.prepare("SELECT * FROM code_threads WHERE id=?").get(id);
    this.db
      .prepare(`INSERT INTO code_threads(id,pinned,archived) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET pinned=excluded.pinned,archived=excluded.archived`)
      .run(
        id,
        Number(patch.pinned ?? current?.pinned ?? false),
        Number(patch.archived ?? current?.archived ?? false),
      );
    return this.codeThreads();
  }

  piSession(sessionId) {
    return this.db
      .prepare("SELECT workspace,provider FROM pi_runs WHERE session_id=? ORDER BY id DESC LIMIT 1")
      .get(sessionId);
  }

  piSessionTurns(sessionId) {
    return this.db
      .prepare(
        "SELECT prompt,response,status FROM pi_runs WHERE session_id=? ORDER BY id DESC LIMIT 6",
      )
      .all(sessionId)
      .reverse();
  }

  getSetting(key, fallback) {
    const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setSetting(key, value) {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  addDoc(source, file, part, role, title, text, modifiedAt) {
    const body = redact(text).slice(0, 100000);
    if (!body.trim()) return false;
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    if (this.getDigest.get(source, file, part)?.digest === digest) return false;
    this.upsert.run(
      source,
      file,
      part,
      role,
      title,
      body,
      digest,
      modifiedAt,
      new Date().toISOString(),
    );
    return true;
  }

  fileIsFresh(source, file, stat) {
    const row = this.getScannedFile.get(source, file);
    return row?.mtime_ms === Math.trunc(stat.mtimeMs) && row?.size === stat.size;
  }

  markScanned(source, file, stat) {
    this.putScannedFile.run(source, file, Math.trunc(stat.mtimeMs), stat.size);
  }

  stats() {
    const rows = this.db
      .prepare("SELECT source, COUNT(*) AS count FROM docs GROUP BY source")
      .all();
    const counts = Object.fromEntries(rows.map((row) => [row.source, row.count]));
    return {
      code: counts.code || 0,
      codex: counts.codex || 0,
      cursor: counts.cursor || 0,
      total: rows.reduce((sum, row) => sum + row.count, 0),
      memories: this.db.prepare("SELECT COUNT(*) AS count FROM harness_synced").get().count,
      lastScan: this.getSetting("lastScan", null),
    };
  }

  search(query, limit = 12) {
    const stopWords = new Set([
      "a",
      "about",
      "and",
      "are",
      "built",
      "can",
      "did",
      "do",
      "does",
      "for",
      "from",
      "have",
      "how",
      "in",
      "into",
      "is",
      "it",
      "its",
      "me",
      "my",
      "of",
      "on",
      "one",
      "our",
      "please",
      "sentence",
      "the",
      "this",
      "to",
      "use",
      "was",
      "what",
      "when",
      "where",
      "which",
      "who",
      "with",
      "would",
      "you",
      "your",
    ]);
    const words = [
      ...new Set(
        (query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []).filter(
          (word) => !stopWords.has(word),
        ),
      ),
    ].slice(0, 12);
    if (!words.length) return [];
    const quoted = words.map((word) => `"${word.replaceAll('"', "")}"`);
    const candidateLimit = Math.min(600, Math.max(100, limit * 40));
    const statement = this.db
      .prepare(`SELECT d.id,d.source,d.path,d.part,d.role,d.title,d.body,d.digest,
      snippet(docs_fts,1,'','', ' … ', 35) AS excerpt,d.modified_at,
      bm25(docs_fts,1,5) AS relevance
      FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE docs_fts MATCH ?
      ORDER BY relevance LIMIT ?`);
    const candidatesById = new Map();
    const matches = [];
    if (quoted.length >= 3) matches.push(quoted.slice(0, 3).join(" AND "));
    if (quoted.length >= 2) matches.push(quoted.slice(0, 2).join(" AND "));
    matches.push(quoted.join(" OR "));
    for (const match of matches) {
      for (const candidate of statement.all(match, candidateLimit))
        candidatesById.set(candidate.id, candidate);
      if (candidatesById.size >= candidateLimit) break;
    }
    const candidates = [...candidatesById.values()]
      .map((candidate) => {
        const title = candidate.title.toLowerCase();
        const body = candidate.body.toLowerCase();
        const coverage = words.reduce(
          (score, word) => score + (body.includes(word) ? 2 : 0) + (title.includes(word) ? 0.5 : 0),
          0,
        );
        return { ...candidate, coverage };
      })
      .sort((a, b) => b.coverage - a.coverage || a.relevance - b.relevance);
    const seen = new Set();
    const results = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.digest)) continue;
      seen.add(candidate.digest);
      const { digest: _digest, coverage: _coverage, relevance: _relevance, ...result } = candidate;
      results.push(result);
      if (results.length >= limit) break;
    }
    return results;
  }

  async scan({ roots = defaultCodeRoots(), trajectoryRoots, progress = () => {} } = {}) {
    const counts = { code: 0, codex: 0, cursor: 0, repos: 0, skipped: 0 };
    if (this.getSetting("codeRedactionVersion", 0) < 1) {
      // Older scans redacted after chunking. Re-read unchanged files once,
      // keeping their existing memories until each file is successfully indexed.
      this.db.exec("DELETE FROM scan_files WHERE source='code'");
      this.setSetting("codeRedactionVersion", 1);
    }
    const repos = await discoverRepos(roots);
    counts.repos = repos.length;
    for (const repo of repos) {
      progress(`Indexing ${path.basename(repo)}…`);
      let output;
      try {
        ({ stdout: output } = await execFileAsync(
          "git",
          ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
          { cwd: repo, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
        ));
      } catch {
        counts.skipped++;
        continue;
      }
      for (const name of output.toString("utf8").split("\0").filter(Boolean)) {
        if (!isCodeFile(name) || name.split("/").some((segment) => SKIP_DIRS.has(segment)))
          continue;
        const file = path.join(repo, name);
        let stat;
        try {
          stat = await fsp.lstat(file);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > MAX_CODE_BYTES) {
          counts.skipped++;
          continue;
        }
        if (this.fileIsFresh("code", file, stat)) continue;
        let content;
        try {
          content = await fsp.readFile(file, "utf8");
        } catch {
          counts.skipped++;
          continue;
        }
        if (content.includes("\0")) {
          counts.skipped++;
          continue;
        }
        const chunks = redact(content).match(new RegExp(`[\\s\\S]{1,${CHUNK_CHARS}}`, "g")) || [];
        for (let i = 0; i < chunks.length; i++) {
          if (
            this.addDoc(
              "code",
              file,
              i,
              "",
              `${path.basename(repo)}/${name}`,
              chunks[i],
              stat.mtime.toISOString(),
            )
          )
            counts.code++;
        }
        this.db
          .prepare("DELETE FROM docs WHERE source=? AND path=? AND part>=?")
          .run("code", file, chunks.length);
        this.markScanned("code", file, stat);
      }
    }
    const sources = trajectoryRoots || [
      ["codex", path.join(os.homedir(), ".codex", "sessions")],
      ["codex", path.join(os.homedir(), ".codex", "archived_sessions")],
      ["cursor", path.join(os.homedir(), ".cursor", "projects")],
    ];
    for (const [source, root] of sources) {
      progress(`Indexing ${source} conversations…`);
      for await (const file of filesBelow(
        root,
        (name) =>
          name.endsWith(".jsonl") &&
          (source !== "cursor" || name.includes(`${path.sep}agent-transcripts${path.sep}`)),
      )) {
        let part = 0;
        let stat;
        try {
          stat = await fsp.stat(file);
        } catch {
          continue;
        }
        if (this.fileIsFresh(source, file, stat)) continue;
        const stream = fs.createReadStream(file, { encoding: "utf8" });
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            const item = parseTrajectoryLine(source, line);
            if (!item) continue;
            if (
              this.addDoc(
                source,
                file,
                part,
                item.role,
                `${source} · ${path.basename(file)} · ${item.role}`,
                item.text,
                item.timestamp || stat.mtime.toISOString(),
              )
            )
              counts[source]++;
            part++;
          }
        } catch (error) {
          if (error !== stream.errored) throw error;
          counts.skipped++;
          continue;
        } finally {
          lines.close();
          stream.destroy();
        }
        this.db
          .prepare("DELETE FROM docs WHERE source=? AND path=? AND part>=?")
          .run(source, file, part);
        this.markScanned(source, file, stat);
      }
    }
    this.setSetting("lastScan", new Date().toISOString());
    return { ...counts, stats: this.stats() };
  }

  async syncHarness(harness, progress = () => {}) {
    await harness.seedUser("local");
    const rows = this.db
      .prepare(`SELECT d.id,d.source,d.path,d.part,d.role,d.body,d.modified_at
      FROM docs d LEFT JOIN harness_synced h ON h.doc_id=d.id
      WHERE d.source IN ('codex','cursor') ORDER BY d.path,d.part`)
      .all();
    let prompt = null;
    let responses = [];
    let previousPath = null;
    let saved = 0;
    const saveTurn = async () => {
      if (!prompt || !responses.length) return;
      // Codex can emit progress before its final answer. Track the last
      // assistant row so a later result is not hidden by an earlier sync.
      const row = responses.at(-1);
      const already = this.db.prepare("SELECT 1 FROM harness_synced WHERE doc_id=?").get(row.id);
      if (already) return;
      await harness.saveMemory({
        userId: "local",
        prompt: prompt.body.slice(0, 6000),
        response: responses
          .map((message) => message.body)
          .join("\n\n")
          .slice(-6000),
        summary: `${row.source} coding trajectory`,
        source: `local-${row.source}`,
        sourceContext: row.path,
        sessionId: crypto.createHash("sha256").update(row.path).digest("hex").slice(0, 24),
        timestamp: row.modified_at || new Date().toISOString(),
        subjects: [],
      });
      this.db
        .prepare("INSERT OR REPLACE INTO harness_synced(doc_id,synced_at) VALUES(?,?)")
        .run(row.id, new Date().toISOString());
      saved++;
      if (saved % 25 === 0) progress(`Stored ${saved} conversation memories…`);
    };
    for (const row of rows) {
      if (row.path !== previousPath) {
        await saveTurn();
        prompt = null;
        responses = [];
      }
      previousPath = row.path;
      if (row.role === "user") {
        await saveTurn();
        prompt = row;
        responses = [];
      } else if (row.role === "assistant" && prompt) responses.push(row);
    }
    await saveTurn();
    return saved;
  }

  async exportCloudBundle() {
    const destination = path.join(this.dataDir, "cloud-upload-ready.jsonl");
    const temp = `${destination}.tmp`;
    const out = fs.createWriteStream(temp, { mode: 0o600 });
    const seenCode = new Set();
    for (const doc of this.db
      .prepare(
        "SELECT source,path,part,role,title,body,modified_at,digest FROM docs ORDER BY source,path,part",
      )
      .iterate()) {
      if (doc.source === "code") {
        if (seenCode.has(doc.digest)) continue;
        seenCode.add(doc.digest);
      }
      const { digest: _digest, ...payload } = doc;
      if (!out.write(`${JSON.stringify({ format: "ditto-local-memory-v1", ...payload })}\n`)) {
        await new Promise((resolve) => out.once("drain", resolve));
      }
    }
    await new Promise((resolve, reject) => {
      out.on("error", reject);
      out.end(resolve);
    });
    await fsp.rename(temp, destination);
    return destination;
  }

  async exportDittoImport() {
    const folder = path.join(
      this.dataDir,
      `ditto-import-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    );
    await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
    const files = [];
    const seenCode = new Set();
    const maxRecordsPerArchive = 15000;
    let zip = null;
    let output = null;
    let finished = null;
    let count = 0;
    let rawBytes = 0;
    let records = 0;
    const startArchive = () => {
      const archive = path.join(
        folder,
        `ditto-import-${String(files.length + 1).padStart(3, "0")}.zip`,
      );
      zip = new yazl.ZipFile();
      output = fs.createWriteStream(archive, { mode: 0o600 });
      finished = new Promise((resolve, reject) => {
        output.on("finish", resolve);
        output.on("error", reject);
        zip.outputStream.on("error", reject);
      });
      zip.outputStream.pipe(output);
      files.push(archive);
      count = 0;
      rawBytes = 0;
    };
    const finishArchive = async () => {
      if (!zip) return;
      zip.end();
      await finished;
      zip = null;
    };
    try {
      for (const doc of this.db
        .prepare(
          "SELECT source,path,part,role,title,body,modified_at,digest FROM docs ORDER BY source,path,part",
        )
        .iterate()) {
        if (doc.source === "code") {
          if (seenCode.has(doc.digest)) continue;
          seenCode.add(doc.digest);
        }
        const id = crypto
          .createHash("sha256")
          .update(`${doc.source}\0${doc.path}\0${doc.part}`)
          .digest("hex");
        const title = doc.title.replace(/\s+/g, " ").slice(0, 250);
        const note = `# ${title}\n\nSource: ${doc.source}\nRole: ${doc.role || "file"}\nOriginal path: ${doc.path}\nCaptured: ${doc.modified_at || "unknown"}\n\n---\n\n${doc.body}\n`;
        const data = Buffer.from(note);
        if (!zip) startArchive();
        if (count >= maxRecordsPerArchive || rawBytes + data.length > 100 * 1024 * 1024) {
          await finishArchive();
          startArchive();
        }
        const mtime = new Date(doc.modified_at || Date.now());
        zip.addBuffer(data, `notes/${doc.source}/${id}.md`, {
          mtime: Number.isNaN(mtime.getTime()) ? new Date() : mtime,
          mode: 0o600,
        });
        count++;
        rawBytes += data.length;
        records++;
      }
      await finishArchive();
      return { folder, files, records };
    } catch (error) {
      if (output) output.destroy();
      throw error;
    }
  }
}

module.exports = {
  MemoryStore,
  defaultCodeRoots,
  parseTrajectoryLine,
  redact,
};
