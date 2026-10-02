const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const execFileAsync = promisify(execFile);
const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.html', '.java', '.js', '.jsx',
  '.json', '.kt', '.md', '.mjs', '.php', '.py', '.rb', '.rs', '.scss', '.sh', '.sql',
  '.swift', '.toml', '.ts', '.tsx', '.vue', '.yaml', '.yml', '.zsh',
]);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.venv', 'venv', '.t3', '.codex', '.cursor']);
const SKIP_NAMES = /(^\.env($|\.)|\.pem$|\.key$|\.p12$|\.pfx$|(^|[-_.])(secret|credential|token)([-_.]|$)|(^package-lock|^pnpm-lock|^yarn\.lock$))/i;
const MAX_CODE_BYTES = 512 * 1024;
const CHUNK_CHARS = 12000;

function redact(text) {
  return String(text)
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[private key removed]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|ditto_mcp_[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16})\b/g, '[credential removed]')
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?)[^\s"',;]{12,}/gi, '$1[credential removed]');
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && typeof item === 'object' && ['text', 'input_text', 'output_text'].includes(item.type))
    .map(item => typeof item.text === 'string' ? item.text : '')
    .join('\n');
}

function parseTrajectoryLine(source, line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (source === 'codex') {
    if (record.type !== 'response_item' || record.payload?.type !== 'message') return null;
    const role = record.payload.role;
    if (role !== 'user' && role !== 'assistant') return null;
    const text = textFromContent(record.payload.content).trim();
    return text ? { role, text, timestamp: record.timestamp || null } : null;
  }
  if (source === 'cursor') {
    const role = record.role;
    if (role !== 'user' && role !== 'assistant') return null;
    const text = textFromContent(record.message?.content).trim();
    return text ? { role, text, timestamp: record.timestamp || record.message?.timestamp || null } : null;
  }
  return null;
}

async function* filesBelow(root, predicate) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) || root.includes('.codex') || root.includes('.cursor')) {
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
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some(entry => entry.name === '.git')) {
      repos.add(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        await visit(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  for (const root of roots) await visit(root, 0);
  return [...repos].sort();
}

function isCodeFile(name) {
  const base = path.basename(name);
  return !SKIP_NAMES.test(base) &&
    (CODE_EXTENSIONS.has(path.extname(base).toLowerCase()) || ['Dockerfile', 'Makefile', 'Justfile', 'AGENTS.md', 'README'].includes(base));
}

function defaultCodeRoots() {
  const home = os.homedir();
  return [
    path.join(home, 'code'), path.join(home, 'Documents', 'ChatGPT'),
    path.join(home, 'Documents', 'Codex'), path.join(home, 'heyditto-stack'),
    path.join(home, 'aiq'),
  ];
}

class MemoryStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dataDir = dataDir;
    this.db = new DatabaseSync(path.join(dataDir, 'local-memory.sqlite'));
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
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scan_files (
        source TEXT NOT NULL, path TEXT NOT NULL, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
        PRIMARY KEY(source,path)
      );
    `);
    this.upsert = this.db.prepare(`INSERT INTO docs(source,path,part,role,title,body,digest,modified_at,indexed_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source,path,part) DO UPDATE SET
      role=excluded.role,title=excluded.title,body=excluded.body,digest=excluded.digest,
      modified_at=excluded.modified_at,indexed_at=excluded.indexed_at
      WHERE docs.digest<>excluded.digest`);
    this.getDigest = this.db.prepare('SELECT digest FROM docs WHERE source=? AND path=? AND part=?');
    this.getScannedFile = this.db.prepare('SELECT mtime_ms,size FROM scan_files WHERE source=? AND path=?');
    this.putScannedFile = this.db.prepare(`INSERT INTO scan_files(source,path,mtime_ms,size) VALUES(?,?,?,?)
      ON CONFLICT(source,path) DO UPDATE SET mtime_ms=excluded.mtime_ms,size=excluded.size`);
  }

  close() { this.db.close(); }

  getSetting(key, fallback) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }

  addDoc(source, file, part, role, title, text, modifiedAt) {
    const body = redact(text).slice(0, 100000);
    if (!body.trim()) return false;
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    if (this.getDigest.get(source, file, part)?.digest === digest) return false;
    this.upsert.run(source, file, part, role, title, body, digest, modifiedAt, new Date().toISOString());
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
    const rows = this.db.prepare('SELECT source, COUNT(*) AS count FROM docs GROUP BY source').all();
    const counts = Object.fromEntries(rows.map(row => [row.source, row.count]));
    return {
      code: counts.code || 0, codex: counts.codex || 0, cursor: counts.cursor || 0,
      total: rows.reduce((sum, row) => sum + row.count, 0),
      memories: this.db.prepare('SELECT COUNT(*) AS count FROM harness_synced').get().count,
      lastScan: this.getSetting('lastScan', null),
    };
  }

  search(query, limit = 12) {
    const words = query.match(/[\p{L}\p{N}_-]{2,}/gu)?.slice(0, 12) || [];
    if (!words.length) return [];
    const match = words.map(word => `"${word.replaceAll('"', '')}"`).join(' OR ');
    const candidates = this.db.prepare(`SELECT d.id,d.source,d.path,d.part,d.role,d.title,d.body,d.digest,
      snippet(docs_fts,1,'','', ' … ', 35) AS excerpt,d.modified_at
      FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE docs_fts MATCH ?
      ORDER BY rank LIMIT ?`).all(match, Math.min(500, Math.max(50, limit * 25)));
    const seen = new Set();
    const results = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.digest)) continue;
      seen.add(candidate.digest);
      const { digest: _digest, ...result } = candidate;
      results.push(result);
      if (results.length >= limit) break;
    }
    return results;
  }

  async scan({ roots = defaultCodeRoots(), trajectoryRoots, progress = () => {} } = {}) {
    const counts = { code: 0, codex: 0, cursor: 0, repos: 0, skipped: 0 };
    const repos = await discoverRepos(roots);
    counts.repos = repos.length;
    for (const repo of repos) {
      progress(`Indexing ${path.basename(repo)}…`);
      let output;
      try {
        ({ stdout: output } = await execFileAsync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
          { cwd: repo, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }));
      } catch { counts.skipped++; continue; }
      for (const name of output.toString('utf8').split('\0').filter(Boolean)) {
        if (!isCodeFile(name) || name.split('/').some(segment => SKIP_DIRS.has(segment))) continue;
        const file = path.join(repo, name);
        let stat;
        try { stat = await fsp.lstat(file); } catch { continue; }
        if (!stat.isFile() || stat.size > MAX_CODE_BYTES) { counts.skipped++; continue; }
        if (this.fileIsFresh('code', file, stat)) continue;
        let content;
        try { content = await fsp.readFile(file, 'utf8'); } catch { counts.skipped++; continue; }
        if (content.includes('\0')) { counts.skipped++; continue; }
        const chunks = content.match(new RegExp(`[\\s\\S]{1,${CHUNK_CHARS}}`, 'g')) || [];
        for (let i = 0; i < chunks.length; i++) {
          if (this.addDoc('code', file, i, '', `${path.basename(repo)}/${name}`, chunks[i], stat.mtime.toISOString())) counts.code++;
        }
        this.db.prepare('DELETE FROM docs WHERE source=? AND path=? AND part>=?').run('code', file, chunks.length);
        this.markScanned('code', file, stat);
      }
    }
    const sources = trajectoryRoots || [
      ['codex', path.join(os.homedir(), '.codex', 'sessions')],
      ['codex', path.join(os.homedir(), '.codex', 'archived_sessions')],
      ['cursor', path.join(os.homedir(), '.cursor', 'projects')],
    ];
    for (const [source, root] of sources) {
      progress(`Indexing ${source} conversations…`);
      for await (const file of filesBelow(root, name => name.endsWith('.jsonl') &&
        (source !== 'cursor' || name.includes(`${path.sep}agent-transcripts${path.sep}`)))) {
        let part = 0;
        let stat;
        try { stat = await fsp.stat(file); } catch { continue; }
        if (this.fileIsFresh(source, file, stat)) continue;
        const stream = fs.createReadStream(file, { encoding: 'utf8' });
        const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of lines) {
          const item = parseTrajectoryLine(source, line);
          if (!item) continue;
          if (this.addDoc(source, file, part, item.role, `${source} · ${path.basename(file)} · ${item.role}`,
            item.text, item.timestamp || stat.mtime.toISOString())) counts[source]++;
          part++;
        }
        this.db.prepare('DELETE FROM docs WHERE source=? AND path=? AND part>=?').run(source, file, part);
        this.markScanned(source, file, stat);
      }
    }
    this.setSetting('lastScan', new Date().toISOString());
    return { ...counts, stats: this.stats() };
  }

  async syncHarness(harness, progress = () => {}) {
    await harness.seedUser('local');
    const rows = this.db.prepare(`SELECT d.id,d.source,d.path,d.part,d.role,d.body,d.modified_at
      FROM docs d LEFT JOIN harness_synced h ON h.doc_id=d.id
      WHERE d.source IN ('codex','cursor') ORDER BY d.path,d.part`).all();
    let prompt = null;
    let previousPath = null;
    let saved = 0;
    for (const row of rows) {
      if (row.path !== previousPath) prompt = null;
      previousPath = row.path;
      if (row.role === 'user') { prompt = row; continue; }
      if (row.role !== 'assistant' || !prompt) continue;
      const already = this.db.prepare('SELECT 1 FROM harness_synced WHERE doc_id=?').get(row.id);
      if (already) { prompt = null; continue; }
      await harness.saveMemory({
        userId: 'local', prompt: prompt.body.slice(0, 6000), response: row.body.slice(0, 6000),
        summary: `${row.source} coding trajectory`, source: `local-${row.source}`,
        sourceContext: row.path, sessionId: crypto.createHash('sha256').update(row.path).digest('hex').slice(0, 24),
        timestamp: row.modified_at || new Date().toISOString(), subjects: [],
      });
      this.db.prepare('INSERT OR REPLACE INTO harness_synced(doc_id,synced_at) VALUES(?,?)')
        .run(row.id, new Date().toISOString());
      saved++;
      if (saved % 25 === 0) progress(`Stored ${saved} conversation memories…`);
      prompt = null;
    }
    return saved;
  }

  async exportCloudBundle() {
    const destination = path.join(this.dataDir, 'cloud-upload-ready.jsonl');
    const temp = `${destination}.tmp`;
    const out = fs.createWriteStream(temp, { mode: 0o600 });
    const seenCode = new Set();
    for (const doc of this.db.prepare('SELECT source,path,part,role,title,body,modified_at,digest FROM docs ORDER BY source,path,part').iterate()) {
      if (doc.source === 'code') {
        if (seenCode.has(doc.digest)) continue;
        seenCode.add(doc.digest);
      }
      const { digest: _digest, ...payload } = doc;
      if (!out.write(`${JSON.stringify({ format: 'ditto-local-memory-v1', ...payload })}\n`)) {
        await new Promise(resolve => out.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
    await fsp.rename(temp, destination);
    return destination;
  }
}

module.exports = { MemoryStore, defaultCodeRoots, discoverRepos, isCodeFile, parseTrajectoryLine, redact };
