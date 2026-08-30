// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the Node filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "@effect/vitest";

import { DiscordMediaCache } from "./DiscordMediaCache.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
  "base64",
);

function withTempDir(run: (directory: string) => Promise<void>) {
  return async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "discord-media-"));
    try {
      await run(directory);
    } finally {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    }
  };
}

describe("DiscordMediaCache", () => {
  it(
    "caches a validated Discord image once and reuses the local file",
    withTempDir(async (attachmentsDir) => {
      const fetch = vi.fn(
        async () =>
          new Response(PNG, {
            headers: { "content-length": String(PNG.byteLength), "content-type": "image/png" },
          }),
      );
      const cache = new DiscordMediaCache({ attachmentsDir, fetch });
      const source = {
        id: "123",
        mediaType: "image/png",
        byteSize: PNG.byteLength,
        remoteUrl: "https://media.discordapp.net/attachments/1/123/image.png",
      };

      const first = await cache.cache(source);
      const second = await cache.cache(source);

      expect(first).toEqual(second);
      expect(first.state).toBe("cached");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(NodeFS.readdirSync(attachmentsDir)).toHaveLength(1);
    }),
  );

  it(
    "rejects non-Discord hosts without making a request",
    withTempDir(async (attachmentsDir) => {
      const fetch = vi.fn();
      const cache = new DiscordMediaCache({ attachmentsDir, fetch });
      const result = await cache.cache({
        id: "123",
        mediaType: "image/png",
        remoteUrl: "https://example.com/image.png",
      });

      expect(result).toEqual({ state: "unavailable" });
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it(
    "does not request an expired Discord signed URL",
    withTempDir(async (attachmentsDir) => {
      const fetch = vi.fn();
      const cache = new DiscordMediaCache({ attachmentsDir, fetch, now: () => 2_000_000 });
      const result = await cache.cache({
        id: "123",
        mediaType: "image/png",
        remoteUrl: "https://cdn.discordapp.com/attachments/1/123/image.png?ex=1",
      });

      expect(result).toEqual({ state: "expired" });
      expect(fetch).not.toHaveBeenCalled();
    }),
  );

  it(
    "rejects a mismatched response type and an oversized declaration",
    withTempDir(async (attachmentsDir) => {
      const fetch = vi.fn(
        async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
      );
      const cache = new DiscordMediaCache({ attachmentsDir, fetch });
      const mismatch = await cache.cache({
        id: "type-mismatch",
        mediaType: "image/png",
        remoteUrl: "https://cdn.discordapp.com/attachments/1/123/image.png",
      });
      const oversized = await cache.cache({
        id: "too-large",
        mediaType: "image/png",
        byteSize: 26 * 1024 * 1024,
        remoteUrl: "https://cdn.discordapp.com/attachments/1/456/image.png",
      });

      expect(mismatch).toEqual({ state: "unavailable" });
      expect(oversized).toEqual({ state: "unavailable" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );

  it(
    "removes only stale Discord cache entries during its bounded sweep",
    withTempDir(async (attachmentsDir) => {
      const stale = NodePath.join(
        attachmentsDir,
        "discord-00000000-0000-4000-8000-000000000000.png",
      );
      const unrelated = NodePath.join(attachmentsDir, "thread-owned.png");
      NodeFS.writeFileSync(stale, PNG);
      NodeFS.writeFileSync(unrelated, PNG);
      NodeFS.utimesSync(stale, 0, 0);
      const cache = new DiscordMediaCache({
        attachmentsDir,
        fetch: vi.fn(),
        now: () => 40 * 24 * 60 * 60 * 1000,
      });

      await cache.cache({
        id: "sweep",
        mediaType: "image/png",
        remoteUrl: "https://example.com/image.png",
      });

      expect(NodeFS.existsSync(stale)).toBe(false);
      expect(NodeFS.existsSync(unrelated)).toBe(true);
    }),
  );
});
