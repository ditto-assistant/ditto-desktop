/**
 * Pure helpers for building a teleport capsule: what to exclude, how to chunk
 * artifacts, how Claude Code names its per-project session directory, and the
 * manifest shape the Ditto API commits. No I/O here so the rules are unit
 * testable.
 */
import * as NodeCrypto from "node:crypto";

import type { TeleportHarness } from "@t3tools/contracts";

/** Chunks stay under the Ditto storage layer's 25 MiB single-object cap. */
export const TELEPORT_CHUNK_BYTES = 24 * 1024 * 1024;

/** The Ditto API accepts at most this many chunks per negotiate call. */
export const TELEPORT_NEGOTIATE_BATCH = 200;

/** Manifest schema version the Ditto API validates (`v`). */
export const TELEPORT_MANIFEST_VERSION = 1;

/**
 * Paths that never travel inside a capsule. Secrets are excluded by
 * construction (`.env*`, key material) and package caches are re-derivable.
 */
export const TELEPORT_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".gradle",
  ".terraform",
  ".DS_Store",
]);

const SECRET_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(?!\.(example|sample|template)$)(\..*)?$/,
  /^\.envrc$/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^credentials(\.json)?$/,
  /^service-account.*\.json$/,
];

/** True when a repository-relative path must be left out of the worktree tar. */
export function isTeleportExcludedPath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return true;
  if (segments.some((segment) => TELEPORT_EXCLUDED_NAMES.has(segment))) return true;
  const base = segments[segments.length - 1] ?? "";
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(base));
}

export interface TeleportChunk {
  readonly sha256: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

/** Splits an artifact into content-addressed chunks of at most `chunkBytes`. */
export function chunkBytes(
  bytes: Uint8Array,
  chunkBytes: number = TELEPORT_CHUNK_BYTES,
): ReadonlyArray<TeleportChunk> {
  if (chunkBytes <= 0) throw new Error("chunkBytes must be positive");
  const chunks: TeleportChunk[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    const slice = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength));
    chunks.push({ sha256: sha256Hex(slice), size: slice.byteLength, bytes: slice });
  }
  return chunks;
}

export function sha256Hex(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Claude Code keeps a project's sessions under
 * `<config dir>/projects/<slug>/<sessionId>.jsonl`, where the slug is the
 * absolute cwd with every path separator, colon and dot replaced by `-`
 * (`/Users/me/.t3/x` → `-Users-me--t3-x`).
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[\\/:.]/g, "-");
}

export interface TeleportManifestChunk {
  readonly sha256: string;
  readonly size: number;
}

/**
 * One repository inside the capsule root. Field names follow the Ditto
 * backend's `teleport.Repo` (pkg/services/teleport/manifest.go).
 */
export interface TeleportRepoManifest {
  readonly relPath: string;
  readonly remotes: ReadonlyArray<{ readonly name: string; readonly url: string }>;
  readonly head: {
    readonly sha: string;
    readonly branch?: string;
    readonly upstream?: string;
  };
  readonly branches: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly packs: ReadonlyArray<{
    readonly kind: "full" | "thin";
    readonly basisGeneration?: number;
    readonly chunks: ReadonlyArray<TeleportManifestChunk>;
  }>;
  readonly worktree: {
    readonly chunks: ReadonlyArray<TeleportManifestChunk>;
    readonly entries: number;
    readonly bytes: number;
  };
}

/** One generation of a capsule, as the Ditto backend's `teleport.Manifest` decodes it. */
export interface TeleportManifest {
  readonly v: typeof TELEPORT_MANIFEST_VERSION;
  readonly capsuleId: string;
  readonly generation: number;
  /** Always `generation - 1`; the server rejects a commit whose parent is not its head. */
  readonly parentGeneration: number;
  readonly createdAt: string;
  readonly machine: Readonly<Record<string, string>>;
  readonly root: { readonly kind: "repo" | "folder"; readonly name: string };
  readonly repos: ReadonlyArray<TeleportRepoManifest>;
  readonly harness: {
    readonly kind: TeleportHarness | "none";
    readonly sessionId?: string;
    readonly cwd: string;
    readonly chunks: ReadonlyArray<TeleportManifestChunk>;
  };
  readonly excludes: ReadonlyArray<string>;
  readonly totals: {
    readonly chunks: number;
    readonly bytes: number;
    readonly dedupedBytes: number;
  };
}

/**
 * Serialises a manifest for upload. The same bytes are uploaded as a chunk and
 * embedded verbatim in the commit body, because the server hashes the raw
 * manifest it receives and requires that hash to name an uploaded chunk.
 */
export function encodeManifest(manifest: TeleportManifest): {
  readonly raw: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
} {
  const raw = JSON.stringify(manifest);
  const bytes = new TextEncoder().encode(raw);
  return { raw, bytes, sha256: sha256Hex(bytes) };
}

/**
 * The commit request body with the manifest embedded byte-for-byte, so
 * `manifestSha256` matches what the server recomputes from `manifest`.
 */
export function commitEnvelope(input: {
  readonly rawManifest: string;
  readonly manifestSha256: string;
  readonly committedBy: string;
}): string {
  return `{"manifest":${input.rawManifest},"manifestSha256":${JSON.stringify(input.manifestSha256)},"committedBy":${JSON.stringify(input.committedBy)}}`;
}

/** Splits a list into consecutive batches of at most `size`. */
export function batched<T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> {
  if (size <= 0) throw new Error("batch size must be positive");
  const out: Array<ReadonlyArray<T>> = [];
  for (let offset = 0; offset < items.length; offset += size) {
    out.push(items.slice(offset, offset + size));
  }
  return out;
}

/** The refs a thin bundle is built against: one sha per branch from the last generation. */
export interface TeleportBasis {
  readonly generation: number;
  readonly repos: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** Parses `git for-each-ref --format='%(refname:short) %(objectname)' refs/heads`. */
export function parseBranchTips(output: string): ReadonlyArray<{ name: string; sha: string }> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [name, sha] = line.split(/\s+/);
      return name && sha ? [{ name, sha }] : [];
    });
}

/** Parses `git remote -v` into unique fetch remotes. */
export function parseRemotes(output: string): ReadonlyArray<{ name: string; url: string }> {
  const seen = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (match?.[1] && match[2] && !seen.has(match[1])) seen.set(match[1], match[2]);
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }));
}

/** Filters `git ls-files -z` output (NUL separated) through the exclusion rules. */
export function filterWorktreeEntries(nulSeparated: string): ReadonlyArray<string> {
  const unique = new Set<string>();
  for (const entry of nulSeparated.split("\0")) {
    if (entry.length === 0 || isTeleportExcludedPath(entry)) continue;
    unique.add(entry);
  }
  return [...unique].sort();
}

export function capsuleNameFor(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop();
  return base && base.length > 0 ? base : "capsule";
}
