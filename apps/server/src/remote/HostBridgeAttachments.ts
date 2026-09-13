/**
 * Turn attachments land in `<cwd>/.tmp/ditto/attachments/<turnId>/<name>` so
 * the harness can read them by relative path. The directory is kept out of
 * git through `.git/info/exclude`; `.gitignore` is never edited.
 *
 * @module remote/HostBridgeAttachments
 */
import * as NodeCrypto from "node:crypto";

import type { HostBridgeAttachment } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

export const ATTACHMENTS_RELATIVE_DIR = ".tmp/ditto/attachments";
const EXCLUDE_ENTRY = "/.tmp/ditto/";

export class HostBridgeAttachmentError extends Schema.TaggedError<HostBridgeAttachmentError>()(
  "HostBridgeAttachmentError",
  {
    attachmentId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Download step, injectable so tests can serve bytes without a network. */
export interface HostBridgeFetchShape {
  readonly download: (url: string) => Effect.Effect<Uint8Array, HostBridgeAttachmentError>;
}

export class HostBridgeFetch extends Context.Service<HostBridgeFetch, HostBridgeFetchShape>()(
  "t3/remote/HostBridgeAttachments/HostBridgeFetch",
) {}

export const makeHttpClientHostBridgeFetch = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  return {
    download: (url) =>
      client.get(url).pipe(
        Effect.mapError(
          (cause) =>
            new HostBridgeAttachmentError({
              attachmentId: url,
              detail: "Attachment download failed.",
              cause,
            }),
        ),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? response.arrayBuffer.pipe(
                Effect.map((buffer) => new Uint8Array(buffer)),
                Effect.mapError(
                  (cause) =>
                    new HostBridgeAttachmentError({
                      attachmentId: url,
                      detail: "Attachment body could not be read.",
                      cause,
                    }),
                ),
              )
            : Effect.fail(
                new HostBridgeAttachmentError({
                  attachmentId: url,
                  detail: `Attachment download failed with ${response.status}.`,
                }),
              ),
        ),
      ),
  } satisfies HostBridgeFetchShape;
});

export const fetchLayer = Layer.effect(HostBridgeFetch, makeHttpClientHostBridgeFetch);

/** Strips directories and anything that could escape the turn directory. */
export function safeAttachmentFileName(name: string, fallback: string): string {
  const segments = name.replaceAll("\\", "/").split("/");
  const base = (segments[segments.length - 1] ?? "").replace(/^\.+/, "");
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

/** Relative to `cwd`, forward slashes, ready for the prompt. */
export function turnAttachmentsRelativeDir(turnId: string): string {
  return `${ATTACHMENTS_RELATIVE_DIR}/${safeAttachmentFileName(turnId, "turn")}`;
}

/** The prompt the harness receives: the text plus a trailing list of the files it can open. */
export function buildTurnPrompt(text: string, relativePaths: ReadonlyArray<string>): string {
  if (relativePaths.length === 0) return text;
  const list = relativePaths.map((path) => `- ${path}`).join("\n");
  const body = text.trim();
  return body.length === 0 ? `Attached files:\n${list}` : `${body}\n\nAttached files:\n${list}`;
}

/** Adds the attachments directory to `.git/info/exclude` when `cwd` is a git checkout. */
export const ensureAttachmentsExcluded = Effect.fn("ensureAttachmentsExcluded")(
  function* (cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitPath = path.join(cwd, ".git");
    if (!(yield* fs.exists(gitPath))) return;
    const info = yield* fs.stat(gitPath);
    // A worktree's `.git` is a file pointing at the real gitdir; exclude lives there.
    let infoDir = path.join(gitPath, "info");
    if (info.type === "File") {
      const pointer = yield* fs.readFileString(gitPath);
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (!match) return;
      infoDir = path.join(path.resolve(cwd, match[1]!.trim()), "info");
    }
    const excludePath = path.join(infoDir, "exclude");
    const existing = yield* fs.readFileString(excludePath).pipe(Effect.orElseSucceed(() => ""));
    if (existing.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_ENTRY)) return;
    yield* fs.makeDirectory(infoDir, { recursive: true });
    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    yield* fs.writeFileString(excludePath, `${existing}${separator}${EXCLUDE_ENTRY}\n`);
  },
  Effect.catchCause(() => Effect.void),
);

export interface DownloadedAttachment {
  readonly attachment: HostBridgeAttachment;
  readonly absolutePath: string;
  readonly relativePath: string;
}

export const downloadTurnAttachments = Effect.fn("downloadTurnAttachments")(function* (input: {
  readonly cwd: string;
  readonly turnId: string;
  readonly attachments: ReadonlyArray<HostBridgeAttachment>;
}) {
  if (input.attachments.length === 0) return [] as ReadonlyArray<DownloadedAttachment>;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fetcher = yield* HostBridgeFetch;
  const relativeDir = turnAttachmentsRelativeDir(input.turnId);
  const dir = path.join(input.cwd, ...relativeDir.split("/"));
  yield* ensureAttachmentsExcluded(input.cwd);
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new HostBridgeAttachmentError({
          attachmentId: input.turnId,
          detail: `Could not create ${dir}.`,
          cause,
        }),
    ),
  );
  const used = new Set<string>();
  const downloaded: DownloadedAttachment[] = [];
  for (const [index, attachment] of input.attachments.entries()) {
    let fileName = safeAttachmentFileName(attachment.name, `attachment-${index + 1}`);
    if (used.has(fileName))
      fileName = `${safeAttachmentFileName(attachment.id, "dup")}-${fileName}`;
    used.add(fileName);
    const bytes = yield* fetcher.download(attachment.url);
    if (attachment.sha256.length > 0) {
      const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (digest !== attachment.sha256.toLowerCase()) {
        return yield* new HostBridgeAttachmentError({
          attachmentId: attachment.id,
          detail: `Attachment ${attachment.name} failed its sha256 check.`,
        });
      }
    }
    const absolutePath = path.join(dir, fileName);
    yield* fs.writeFile(absolutePath, bytes).pipe(
      Effect.mapError(
        (cause) =>
          new HostBridgeAttachmentError({
            attachmentId: attachment.id,
            detail: `Could not write ${absolutePath}.`,
            cause,
          }),
      ),
    );
    downloaded.push({ attachment, absolutePath, relativePath: `${relativeDir}/${fileName}` });
  }
  return downloaded as ReadonlyArray<DownloadedAttachment>;
});
