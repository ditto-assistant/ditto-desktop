import { describe, expect, it } from "vite-plus/test";

import {
  batched,
  capsuleNameFor,
  chunkBytes,
  commitEnvelope,
  encodeManifest,
  claudeProjectSlug,
  filterWorktreeEntries,
  isTeleportExcludedPath,
  parseBranchTips,
  parseRemotes,
  sha256Hex,
  TELEPORT_MANIFEST_VERSION,
  type TeleportManifest,
} from "./capsule.ts";

describe("isTeleportExcludedPath", () => {
  it("keeps secrets and caches out of a capsule", () => {
    for (const path of [
      ".env",
      ".env.local",
      "apps/web/.env.production",
      "node_modules/react/index.js",
      "services/api/.venv/bin/python",
      "certs/server.pem",
      "deploy/service-account-prod.json",
      "target/debug/app",
      ".DS_Store",
    ]) {
      expect(isTeleportExcludedPath(path), path).toBe(true);
    }
  });

  it("keeps ordinary source and config", () => {
    for (const path of [
      "src/index.ts",
      "README.md",
      ".env.example",
      "config/env.ts",
      "envs/dev.yaml",
    ]) {
      expect(isTeleportExcludedPath(path), path).toBe(false);
    }
  });
});

describe("chunkBytes", () => {
  it("splits at the chunk size and content-addresses every part", () => {
    const bytes = new Uint8Array(10);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i;
    const chunks = chunkBytes(bytes, 4);
    expect(chunks.map((chunk) => chunk.size)).toEqual([4, 4, 2]);
    expect(chunks[0]?.sha256).toBe(sha256Hex(bytes.subarray(0, 4)));
    expect(new Set(chunks.map((chunk) => chunk.sha256)).size).toBe(3);
  });

  it("produces no chunks for an empty artifact", () => {
    expect(chunkBytes(new Uint8Array(0))).toEqual([]);
  });
});

describe("claudeProjectSlug", () => {
  it("matches Claude Code's project directory naming", () => {
    expect(claudeProjectSlug("/Users/me/.t3/worktrees/backend-x")).toBe(
      "-Users-me--t3-worktrees-backend-x",
    );
    expect(claudeProjectSlug("C:\\code\\app")).toBe("C--code-app");
  });
});

describe("git output parsers", () => {
  it("parses branch tips", () => {
    expect(parseBranchTips("main abc123\nfeat/x def456\n")).toEqual([
      { name: "main", sha: "abc123" },
      { name: "feat/x", sha: "def456" },
    ]);
  });

  it("parses fetch remotes once each", () => {
    const output = [
      "origin\tgit@github.com:ditto/app.git (fetch)",
      "origin\tgit@github.com:ditto/app.git (push)",
      "fork\thttps://github.com/me/app.git (fetch)",
    ].join("\n");
    expect(parseRemotes(output)).toEqual([
      { name: "origin", url: "git@github.com:ditto/app.git" },
      { name: "fork", url: "https://github.com/me/app.git" },
    ]);
  });

  it("filters and dedupes worktree entries", () => {
    expect(filterWorktreeEntries("src/a.ts\0.env\0src/a.ts\0node_modules/x\0docs/b.md\0")).toEqual([
      "docs/b.md",
      "src/a.ts",
    ]);
  });
});

describe("commit envelope", () => {
  const manifest: TeleportManifest = {
    v: TELEPORT_MANIFEST_VERSION,
    capsuleId: "cap-1",
    generation: 2,
    parentGeneration: 1,
    createdAt: "2026-09-05T10:00:00.000Z",
    machine: { hostname: "mac", os: "darwin", arch: "arm64", client: "ditto-desktop" },
    root: { kind: "repo", name: "backend" },
    repos: [],
    harness: { kind: "claude-code", sessionId: "s-1", cwd: "/code/backend", chunks: [] },
    excludes: [],
    totals: { chunks: 1, bytes: 10, dedupedBytes: 0 },
  };

  it("embeds the manifest verbatim so the server's hash matches", () => {
    const encoded = encodeManifest(manifest);
    const body = JSON.parse(
      commitEnvelope({
        rawManifest: encoded.raw,
        manifestSha256: encoded.sha256,
        committedBy: "desktop",
      }),
    ) as { manifest: TeleportManifest; manifestSha256: string; committedBy: string };
    expect(body.manifest).toEqual(manifest);
    expect(body.committedBy).toBe("desktop");
    expect(body.manifestSha256).toBe(
      sha256Hex(new TextEncoder().encode(JSON.stringify(body.manifest))),
    );
  });

  it("batches negotiate requests", () => {
    expect(batched([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batched([], 200)).toEqual([]);
  });
});

describe("capsuleNameFor", () => {
  it("uses the root directory name", () => {
    expect(capsuleNameFor("/Users/me/code/ditto/")).toBe("ditto");
    expect(capsuleNameFor("/")).toBe("capsule");
  });
});
