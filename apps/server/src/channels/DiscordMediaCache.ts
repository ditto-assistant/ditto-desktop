// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off -- Local media cache is a Node host boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 1024 * 1024 * 1024;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const IMAGE_EXTENSIONS = new Map([
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
] as const);

export type DiscordMediaCacheResult =
  | { readonly state: "cached"; readonly attachmentId: string }
  | { readonly state: "expired" | "unavailable" };

export interface DiscordMediaSource {
  readonly id: string;
  readonly mediaType?: string;
  readonly byteSize?: number;
  readonly remoteUrl?: string;
}

export interface DiscordMediaCacheOptions {
  readonly attachmentsDir: string;
  readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

function isAllowedDiscordMediaUrl(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "cdn.discordapp.com" || hostname === "media.discordapp.net") return true;
  const shard = /^images-ext-(\d+)\.discordapp\.net$/.exec(hostname);
  return shard !== null;
}

function signedUrlExpiryMs(url: URL): number | null {
  const encoded = url.searchParams.get("ex");
  if (!encoded || !/^[0-9a-f]+$/i.test(encoded)) return null;
  const seconds = Number.parseInt(encoded, 16);
  return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
}

function deterministicAttachmentId(sourceId: string): string {
  const digest = NodeCrypto.createHash("sha256").update(`discord:${sourceId}`).digest("hex");
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return `discord-${uuid}`;
}

function hasExpectedSignature(mediaType: string, bytes: Uint8Array): boolean {
  switch (mediaType) {
    case "image/png":
      return (
        bytes.length >= 8 &&
        Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      );
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif": {
      const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
      return signature === "GIF87a" || signature === "GIF89a";
    }
    case "image/webp":
      return (
        bytes.length >= 12 &&
        Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
        Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
      );
    default:
      return false;
  }
}

async function boundedBody(response: Response): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export class DiscordMediaCache {
  readonly #attachmentsDir: string;
  readonly #fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly #now: () => number;
  readonly #inflight = new Map<string, Promise<DiscordMediaCacheResult>>();
  readonly #sessionResults = new Map<string, DiscordMediaCacheResult>();
  #lastSweepAt = 0;

  constructor(options: DiscordMediaCacheOptions) {
    this.#attachmentsDir = options.attachmentsDir;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  cache(source: DiscordMediaSource): Promise<DiscordMediaCacheResult> {
    const cacheKey = `${source.id}\u0000${source.mediaType ?? ""}\u0000${source.remoteUrl ?? ""}`;
    const settled = this.#sessionResults.get(cacheKey);
    if (settled) return Promise.resolve(settled);
    const current = this.#inflight.get(cacheKey);
    if (current) return current;
    const pending = this.#cache(source)
      .then((result) => {
        this.#sessionResults.set(cacheKey, result);
        if (this.#sessionResults.size > 10_000) {
          const oldest = this.#sessionResults.keys().next().value;
          if (oldest !== undefined) this.#sessionResults.delete(oldest);
        }
        return result;
      })
      .finally(() => this.#inflight.delete(cacheKey));
    this.#inflight.set(cacheKey, pending);
    return pending;
  }

  async #cache(source: DiscordMediaSource): Promise<DiscordMediaCacheResult> {
    await this.#maybeSweep();
    const mediaType = source.mediaType?.split(";", 1)[0]?.trim().toLowerCase();
    const extension = mediaType ? IMAGE_EXTENSIONS.get(mediaType as never) : undefined;
    if (!mediaType || !extension || (source.byteSize ?? 0) > MAX_IMAGE_BYTES) {
      return { state: "unavailable" };
    }
    const attachmentId = deterministicAttachmentId(source.id);
    const finalPath = resolveAttachmentRelativePath({
      attachmentsDir: this.#attachmentsDir,
      relativePath: `${attachmentId}${extension}`,
    });
    if (!finalPath) return { state: "unavailable" };
    try {
      const info = await NodeFSP.stat(finalPath);
      if (info.isFile()) {
        const touchedAt = this.#now() / 1000;
        await NodeFSP.utimes(finalPath, touchedAt, touchedAt);
        return { state: "cached", attachmentId };
      }
    } catch {
      // Cache miss.
    }

    let url: URL;
    try {
      url = new URL(source.remoteUrl ?? "");
    } catch {
      return { state: "unavailable" };
    }
    if (!isAllowedDiscordMediaUrl(url)) return { state: "unavailable" };
    const expiry = signedUrlExpiryMs(url);
    if (expiry !== null && expiry <= this.#now()) return { state: "expired" };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response | undefined;
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        response = await this.#fetch(url, {
          redirect: "manual",
          signal: controller.signal,
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) return { state: "unavailable" };
        url = new URL(location, url);
        if (!isAllowedDiscordMediaUrl(url)) return { state: "unavailable" };
      }
      if (!response?.ok || !isAllowedDiscordMediaUrl(new URL(response.url || url))) {
        return expiry !== null && expiry <= this.#now()
          ? { state: "expired" }
          : { state: "unavailable" };
      }
      const responseType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (responseType !== mediaType) return { state: "unavailable" };
      const body = await boundedBody(response);
      if (!body || !hasExpectedSignature(mediaType, body)) return { state: "unavailable" };
      await NodeFSP.mkdir(NodePath.dirname(finalPath), { recursive: true });
      const partPath = `${finalPath}.${NodeCrypto.randomUUID()}.part`;
      try {
        await NodeFSP.writeFile(partPath, body, { flag: "wx", mode: 0o600 });
        await NodeFSP.rename(partPath, finalPath);
      } finally {
        await NodeFSP.rm(partPath, { force: true });
      }
      return { state: "cached", attachmentId };
    } catch {
      return { state: "unavailable" };
    } finally {
      clearTimeout(timeout);
    }
  }

  async #maybeSweep(): Promise<void> {
    const now = this.#now();
    if (now - this.#lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.#lastSweepAt = now;
    let entries;
    try {
      entries = await NodeFSP.readdir(this.#attachmentsDir, {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    const cached = [] as Array<{ path: string; mtimeMs: number; size: number }>;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("discord-")) continue;
      const path = resolveAttachmentRelativePath({
        attachmentsDir: this.#attachmentsDir,
        relativePath: entry.name,
      });
      if (!path) continue;
      try {
        const info = await NodeFSP.stat(path);
        if (now - info.mtimeMs > CACHE_MAX_AGE_MS) await NodeFSP.rm(path, { force: true });
        else cached.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        continue;
      }
    }
    let total = cached.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of cached.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (total <= CACHE_MAX_BYTES) break;
      await NodeFSP.rm(entry.path, { force: true });
      total -= entry.size;
    }
  }
}
