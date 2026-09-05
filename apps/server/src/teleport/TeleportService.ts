/**
 * TeleportService — snapshots a thread's working state into a Ditto capsule.
 *
 * Capture runs on the server because the repos, working trees, and harness
 * session files live next to it. The flow mirrors the Ditto CLI so both land
 * in the same capsule format: git bundles per repository (thin against the
 * last generation this machine pushed), a tar of modified and untracked files
 * with secrets and caches excluded, the harness session transcript, all split
 * into content-addressed chunks, negotiated with the Ditto API (which returns
 * presigned PUT URLs only for chunks it does not already hold), uploaded, and
 * committed as a new generation.
 */
import * as NodeOS from "node:os";

import {
  type TeleportCapsuleSummary,
  type TeleportCloudSession,
  TeleportError,
  type TeleportHarness,
  type TeleportLaunchCloudSessionInput,
  type TeleportProgressStage,
  type TeleportThreadInput,
  teleportHarnessForProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  capsuleNameFor,
  chunkBytes,
  claudeProjectSlug,
  filterWorktreeEntries,
  parseBranchTips,
  parseRemotes,
  TELEPORT_EXCLUDED_NAMES,
  type TeleportChunk,
  type TeleportManifest,
  type TeleportRepoManifest,
} from "./capsule.ts";
import { DittoAccountService, type DittoAccountCredentials } from "./DittoAccount.ts";

const UPLOAD_CONCURRENCY = 4;
const UPLOAD_RETRIES = 2;
const REPO_SCAN_DEPTH = 3;

export interface TeleportProgress {
  readonly stage: TeleportProgressStage;
  readonly detail?: string;
  readonly bytesUploaded?: number;
  readonly bytesTotal?: number;
}

export type TeleportProgressReporter = (progress: TeleportProgress) => Effect.Effect<void>;

export class TeleportService extends Context.Service<
  TeleportService,
  {
    readonly teleportThread: (
      input: TeleportThreadInput,
      onProgress: TeleportProgressReporter,
    ) => Effect.Effect<TeleportCapsuleSummary, TeleportError>;
    readonly launchCloudSession: (
      input: TeleportLaunchCloudSessionInput,
    ) => Effect.Effect<TeleportCloudSession, TeleportError>;
  }
>()("t3/teleport/TeleportService") {}

/** What this machine remembers about a thread's capsule between pushes. */
const ThreadCapsuleState = Schema.Struct({
  capsuleId: Schema.String,
  capsuleName: Schema.String,
  generation: Schema.Number,
  /** Branch tips (sha) per repo relative path at the last generation; thin bundles exclude them. */
  basis: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
type ThreadCapsuleState = typeof ThreadCapsuleState.Type;
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadCapsuleState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(ThreadCapsuleState));

/** Ditto API response shapes. Extra fields are ignored so the API can grow. */
const CapsuleRecord = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  headGeneration: Schema.optional(Schema.Number),
});
type CapsuleRecord = typeof CapsuleRecord.Type;
const NegotiateResponse = Schema.Struct({
  missing: Schema.Array(Schema.Struct({ sha256: Schema.String, putUrl: Schema.String })),
});
const CloudSessionRecord = Schema.Struct({
  jobId: Schema.String,
  threadId: Schema.String,
  agentId: Schema.String,
});
const ApiErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const decodeApiErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ApiErrorBody));

interface Artifact {
  readonly label: string;
  readonly bytes: Uint8Array;
}

type ManifestChunk = { readonly sha256: string; readonly size: number };
type RepoPack = TeleportRepoManifest["packs"][number];

const fail = (message: string) => new TeleportError({ message });

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The Ditto web app that fronts an API base, for deep links into a thread. */
export function dittoAppUrlFor(apiBaseUrl: string): string {
  let host: string;
  try {
    host = new URL(apiBaseUrl).hostname;
  } catch {
    return "https://app.heyditto.ai";
  }
  if (host.startsWith("staging-api")) return "https://staging-app.heyditto.ai";
  if (host === "localhost" || host === "127.0.0.1") return "http://localhost:5173";
  return "https://app.heyditto.ai";
}

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const toManifestChunks = (bytes: Uint8Array): ReadonlyArray<ManifestChunk> =>
  chunkBytes(bytes).map(({ sha256, size }) => ({ sha256, size }));

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const runtimes = yield* ProviderSessionRuntimeRepository;
  const settings = yield* ServerSettingsService;
  const account = yield* DittoAccountService;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const decoder = new TextDecoder();

  const machineInfo = () => ({
    hostname: NodeOS.hostname(),
    os: hostPlatform,
    arch: hostArchitecture,
    client: "ditto-desktop",
  });

  const stateDir = path.join(serverConfig.stateDir, "teleport", "threads");

  // ── process helpers ────────────────────────────────────────────────────────

  const collect = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
    Stream.runCollect(stream).pipe(
      Effect.map((parts) => concat(parts)),
      Effect.mapError((cause) => fail(`Could not read process output: ${describe(cause)}`)),
    );

  const run = Effect.fn("TeleportService.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    options: { readonly allowNonZero?: boolean } = {},
  ) {
    const child = yield* spawner
      .spawn(
        ChildProcess.make(command, [...args], {
          cwd,
          env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
        }),
      )
      .pipe(Effect.mapError((cause) => fail(`Could not start ${command}: ${describe(cause)}`)));
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collect(child.stdout),
        collect(child.stderr),
        child.exitCode.pipe(
          Effect.mapError((cause) => fail(`${command} did not exit cleanly: ${describe(cause)}`)),
        ),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0 && !options.allowNonZero) {
      const message = decoder.decode(stderr).trim() || decoder.decode(stdout).trim();
      return yield* fail(`${command} ${args[0] ?? ""} failed (${exitCode}): ${message}`);
    }
    return { exitCode, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) };
  });

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    run("git", args, cwd).pipe(Effect.map((result) => result.stdout.trim()));
  const gitMaybe = (cwd: string, args: ReadonlyArray<string>) =>
    run("git", args, cwd, { allowNonZero: true }).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
    );

  // ── filesystem helpers ─────────────────────────────────────────────────────

  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const readBytes = (target: string) =>
    fs
      .readFile(target)
      .pipe(Effect.mapError((cause) => fail(`Could not read ${target}: ${describe(cause)}`)));

  const isDirectory = (target: string) =>
    fs.stat(target).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const listDirectory = (dir: string) =>
    fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  /** The root itself when it is a repository, else every repository under it (bounded depth). */
  const discoverRepos = Effect.fn("TeleportService.discoverRepos")(function* (root: string) {
    if (yield* exists(path.join(root, ".git"))) return [root];
    const found: string[] = [];
    const walk: (dir: string, depth: number) => Effect.Effect<void> = Effect.fn(
      "TeleportService.walk",
    )(function* (dir: string, depth: number) {
      if (depth > REPO_SCAN_DEPTH) return;
      for (const entry of yield* listDirectory(dir)) {
        if (TELEPORT_EXCLUDED_NAMES.has(entry) || entry.startsWith(".")) continue;
        const candidate = path.join(dir, entry);
        if (!(yield* isDirectory(candidate))) continue;
        if (yield* exists(path.join(candidate, ".git"))) {
          found.push(candidate);
        } else {
          yield* walk(candidate, depth + 1);
        }
      }
    });
    yield* walk(root, 1);
    return found.sort();
  });

  const readState = Effect.fn("TeleportService.readState")(function* (threadId: string) {
    const file = path.join(stateDir, `${threadId}.json`);
    if (!(yield* exists(file))) return Option.none<ThreadCapsuleState>();
    return yield* fs.readFileString(file).pipe(
      Effect.flatMap((json) => decodeState(json)),
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<ThreadCapsuleState>()),
    );
  });

  const writeState = Effect.fn("TeleportService.writeState")(function* (
    threadId: string,
    state: ThreadCapsuleState,
  ) {
    yield* fs.makeDirectory(stateDir, { recursive: true }).pipe(Effect.ignore);
    const json = yield* encodeState(state).pipe(
      Effect.mapError((cause) => fail(`Could not encode capsule state: ${describe(cause)}`)),
    );
    yield* fs
      .writeFileString(path.join(stateDir, `${threadId}.json`), json)
      .pipe(Effect.mapError((cause) => fail(`Could not save capsule state: ${describe(cause)}`)));
  });

  // ── Ditto API ──────────────────────────────────────────────────────────────

  const apiRequest = <A>(
    creds: DittoAccountCredentials,
    request: HttpClientRequest.HttpClientRequest,
    route: string,
    schema: Schema.Decoder<A>,
  ): Effect.Effect<A, TeleportError> =>
    Effect.gen(function* () {
      const response = yield* httpClient
        .execute(
          request.pipe(
            HttpClientRequest.bearerToken(creds.apiKey),
            HttpClientRequest.setHeader("X-Platform", "desktop"),
          ),
        )
        .pipe(
          Effect.mapError((cause) => fail(`Could not reach Ditto (${route}): ${describe(cause)}`)),
        );
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        const message = Option.match(decodeApiErrorBody(text), {
          onNone: () => text,
          onSome: (body) => body.error ?? body.message ?? text,
        });
        return yield* fail(`Ditto returned ${response.status} for ${route}: ${message}`);
      }
      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError((cause) =>
          fail(`Ditto returned an unexpected response for ${route}: ${describe(cause)}`),
        ),
      );
    });

  const apiGet = <A>(creds: DittoAccountCredentials, route: string, schema: Schema.Decoder<A>) =>
    apiRequest(creds, HttpClientRequest.get(`${creds.apiBaseUrl}${route}`), route, schema);

  const apiPost = <A>(
    creds: DittoAccountCredentials,
    route: string,
    body: unknown,
    schema: Schema.Decoder<A>,
  ) =>
    HttpClientRequest.bodyJson(HttpClientRequest.post(`${creds.apiBaseUrl}${route}`), body).pipe(
      Effect.mapError((cause) =>
        fail(`Could not encode the request for ${route}: ${describe(cause)}`),
      ),
      Effect.flatMap((request) => apiRequest(creds, request, route, schema)),
    );

  const uploadChunk = (putUrl: string, chunk: TeleportChunk) =>
    httpClient
      .execute(
        HttpClientRequest.put(putUrl).pipe(
          HttpClientRequest.bodyUint8Array(chunk.bytes, "application/octet-stream"),
        ),
      )
      .pipe(
        Effect.mapError((cause) => fail(`Chunk upload failed: ${describe(cause)}`)),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.void
            : fail(`Chunk upload rejected with ${response.status}.`),
        ),
        Effect.retry({ times: UPLOAD_RETRIES }),
      );

  // ── harness state ──────────────────────────────────────────────────────────

  const resolveHarness = Effect.fn("TeleportService.resolveHarness")(function* (
    input: TeleportThreadInput,
  ) {
    const harness = teleportHarnessForProvider(input.providerName);
    if (harness === null) return { harness: null, sessionId: null } as const;
    const runtime = yield* runtimes
      .getByThreadId({ threadId: input.threadId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const cursor = Option.match(runtime, {
      onNone: () => null,
      onSome: (row) =>
        typeof row.resumeCursor === "object" && row.resumeCursor !== null
          ? (row.resumeCursor as Record<string, unknown>)
          : null,
    });
    const key = harness === "claude-code" ? "resume" : "threadId";
    const value = cursor?.[key];
    return { harness, sessionId: typeof value === "string" ? value : null } as const;
  });

  const harnessHome = Effect.fn("TeleportService.harnessHome")(function* (
    harness: TeleportHarness,
  ) {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const configured =
      harness === "claude-code"
        ? current?.providers.claudeAgent.homePath.trim()
        : current?.providers.codex.homePath.trim();
    if (configured && configured.length > 0) return path.resolve(expandHomePath(configured));
    return path.join(NodeOS.homedir(), harness === "claude-code" ? ".claude" : ".codex");
  });

  /** Files under `dir` whose name contains `needle`, up to a small depth. */
  const findFiles = Effect.fn("TeleportService.findFiles")(function* (
    dir: string,
    needle: string,
    depth: number,
  ) {
    const matches: string[] = [];
    const walk: (current: string, remaining: number) => Effect.Effect<void> = Effect.fn(
      "TeleportService.findFiles.walk",
    )(function* (current: string, remaining: number) {
      for (const entry of yield* listDirectory(current)) {
        const candidate = path.join(current, entry);
        if (yield* isDirectory(candidate)) {
          if (remaining > 0) yield* walk(candidate, remaining - 1);
        } else if (entry.includes(needle)) {
          matches.push(candidate);
        }
      }
    });
    yield* walk(dir, depth);
    return matches.sort();
  });

  const tar = Effect.fn("TeleportService.tar")(function* (
    cwd: string,
    entries: ReadonlyArray<string>,
    output: string,
  ) {
    const listFile = `${output}.list`;
    yield* fs
      .writeFileString(listFile, entries.join("\0"))
      .pipe(Effect.mapError((cause) => fail(`Could not write tar list: ${describe(cause)}`)));
    yield* run("tar", ["-czf", output, "--null", "-T", listFile], cwd);
    return yield* readBytes(output);
  });

  const captureHarnessState = Effect.fn("TeleportService.captureHarnessState")(function* (
    harness: TeleportHarness | null,
    sessionId: string | null,
    cwd: string,
    tmp: string,
  ) {
    if (harness === null || sessionId === null) return null;
    const home = yield* harnessHome(harness);
    if (harness === "claude-code") {
      const projectDir = path.join(home, "projects", claudeProjectSlug(cwd));
      const entries: string[] = [];
      if (yield* exists(path.join(projectDir, `${sessionId}.jsonl`))) {
        entries.push(`${sessionId}.jsonl`);
      }
      if (yield* isDirectory(path.join(projectDir, sessionId))) entries.push(sessionId);
      if (entries.length === 0) return null;
      return yield* tar(projectDir, entries, path.join(tmp, "harness.tgz"));
    }
    const sessionsDir = path.join(home, "sessions");
    const files = yield* findFiles(sessionsDir, sessionId, 4);
    if (files.length === 0) return null;
    const relative = files.map((file) => path.relative(sessionsDir, file));
    return yield* tar(sessionsDir, relative, path.join(tmp, "harness.tgz"));
  });

  // ── repositories ───────────────────────────────────────────────────────────

  const captureRepo = Effect.fn("TeleportService.captureRepo")(function* (
    root: string,
    repo: string,
    index: number,
    basis: ReadonlyArray<string>,
    basisGeneration: number | null,
    tmp: string,
  ) {
    const relPath = path.relative(root, repo) || ".";
    const headSha = yield* git(repo, ["rev-parse", "HEAD"]);
    const branchName = yield* gitMaybe(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const upstream = yield* gitMaybe(repo, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    const remotes = parseRemotes(yield* git(repo, ["remote", "-v"]));
    const tips = parseBranchTips(
      yield* git(repo, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]),
    );
    const tags = parseBranchTips(
      yield* git(repo, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/tags"]),
    );

    // Thin bundle: exclude every commit the last generation already carried
    // that this repository still knows about.
    const exclusions: string[] = [];
    for (const sha of basis) {
      const known = yield* gitMaybe(repo, ["cat-file", "-e", `${sha}^{commit}`]);
      if (known !== null) exclusions.push(`^${sha}`);
    }
    const bundlePath = path.join(tmp, `repo-${index}.bundle`);
    const bundle = yield* run(
      "git",
      ["bundle", "create", bundlePath, "--all", ...exclusions],
      repo,
      { allowNonZero: true },
    );
    const packs: Array<RepoPack> = [];
    const artifacts: Artifact[] = [];
    if (bundle.exitCode === 0) {
      const bytes = yield* readBytes(bundlePath);
      artifacts.push({ label: `${relPath} bundle`, bytes });
      packs.push({
        kind: exclusions.length > 0 ? "thin" : "full",
        ...(exclusions.length > 0 && basisGeneration !== null ? { basisGeneration } : {}),
        chunks: toManifestChunks(bytes),
      });
    } else if (!/empty bundle/i.test(bundle.stderr)) {
      return yield* fail(`git bundle failed in ${relPath}: ${bundle.stderr.trim()}`);
    }

    const listing = yield* run(
      "git",
      ["ls-files", "-z", "--others", "--modified", "--exclude-standard"],
      repo,
    );
    const entries = filterWorktreeEntries(listing.stdout);
    let worktree: TeleportRepoManifest["worktree"] = { chunks: [], entries: 0, bytes: 0 };
    if (entries.length > 0) {
      const bytes = yield* tar(repo, entries, path.join(tmp, `repo-${index}.worktree.tgz`));
      artifacts.push({ label: `${relPath} worktree`, bytes });
      worktree = {
        chunks: toManifestChunks(bytes),
        entries: entries.length,
        bytes: bytes.byteLength,
      };
    }

    const manifest: TeleportRepoManifest = {
      relPath,
      remotes,
      head: { sha: headSha, branch: branchName, upstream },
      refs: { branches: tips.map((tip) => tip.name), tags: tags.map((tag) => tag.name) },
      packs,
      worktree,
    };
    return { manifest, artifacts, tips: tips.map((tip) => tip.sha) };
  });

  const requireCredentials = account.credentials.pipe(
    Effect.mapError((error) => fail(error.message)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          fail("Link your Ditto account first: Settings → Ditto Account → Link this computer."),
        onSome: Effect.succeed,
      }),
    ),
  );

  // ── the teleport ───────────────────────────────────────────────────────────

  const teleportThread: TeleportService["Service"]["teleportThread"] = (input, onProgress) =>
    Effect.gen(function* () {
      const creds = yield* requireCredentials;
      const root = path.resolve(input.cwd);
      if (!(yield* isDirectory(root))) {
        return yield* fail(`The thread's working directory does not exist: ${root}`);
      }

      yield* onProgress({ stage: "preparing", detail: root });
      const repos = yield* discoverRepos(root);
      if (repos.length === 0) {
        return yield* fail("No git repository found under the thread's working directory.");
      }
      const rootKind = repos.length === 1 && repos[0] === root ? "repo" : "folder";
      const { harness, sessionId } = yield* resolveHarness(input);
      const previous = yield* readState(input.threadId);
      const tmp = yield* fs
        .makeTempDirectoryScoped({ prefix: "ditto-teleport-" })
        .pipe(Effect.mapError((cause) => fail(`Could not create a temp dir: ${describe(cause)}`)));

      yield* onProgress({
        stage: "bundling",
        detail: `${repos.length} repositor${repos.length === 1 ? "y" : "ies"}`,
      });
      const repoManifests: TeleportRepoManifest[] = [];
      const artifacts: Artifact[] = [];
      const basisTips: Record<string, ReadonlyArray<string>> = {};
      for (const [index, repo] of repos.entries()) {
        const relPath = path.relative(root, repo) || ".";
        const captured = yield* captureRepo(
          root,
          repo,
          index,
          Option.match(previous, { onNone: () => [], onSome: (s) => s.basis[relPath] ?? [] }),
          Option.match(previous, { onNone: () => null, onSome: (s) => s.generation }),
          tmp,
        );
        repoManifests.push(captured.manifest);
        artifacts.push(...captured.artifacts);
        basisTips[relPath] = captured.tips;
        yield* onProgress({ stage: "bundling", detail: relPath });
      }

      yield* onProgress({ stage: "packing", detail: harness ?? "no harness session" });
      const harnessBytes = yield* captureHarnessState(harness, sessionId, root, tmp);
      if (harnessBytes) artifacts.push({ label: "harness session", bytes: harnessBytes });

      const chunkIndex = new Map<string, TeleportChunk>();
      for (const artifact of artifacts) {
        for (const chunk of chunkBytes(artifact.bytes)) chunkIndex.set(chunk.sha256, chunk);
      }
      const chunks = [...chunkIndex.values()];
      const bytesTotal = chunks.reduce((sum, chunk) => sum + chunk.size, 0);

      // Capsule identity: reuse the one this thread pushed before when the
      // API still knows it; otherwise create a fresh capsule.
      yield* onProgress({ stage: "negotiating", bytesTotal });
      const capsuleName =
        input.capsuleName?.trim() ||
        Option.match(previous, {
          onNone: () => capsuleNameFor(root),
          onSome: (s) => s.capsuleName,
        });
      let capsule: CapsuleRecord | null = null;
      if (Option.isSome(previous)) {
        capsule = yield* apiGet(
          creds,
          `/api/v5/teleport/capsules/${encodeURIComponent(previous.value.capsuleId)}`,
          CapsuleRecord,
        ).pipe(Effect.orElseSucceed((): CapsuleRecord | null => null));
      }
      if (capsule === null) {
        capsule = yield* apiPost(
          creds,
          "/api/v5/teleport/capsules",
          {
            name: capsuleName,
            rootKind,
            machine: machineInfo(),
            harness: { kind: harness, sessionId },
          },
          CapsuleRecord,
        );
      }
      const parentGeneration =
        Option.isSome(previous) && previous.value.capsuleId === capsule.id
          ? previous.value.generation
          : null;
      const generation = (parentGeneration ?? capsule.headGeneration ?? 0) + 1;

      const negotiated = yield* apiPost(
        creds,
        `/api/v5/teleport/capsules/${encodeURIComponent(capsule.id)}/negotiate`,
        {
          generation,
          parentGeneration,
          chunks: chunks.map(({ sha256, size }) => ({ sha256, size })),
        },
        NegotiateResponse,
      );

      const missing = negotiated.missing;
      const bytesMissing = missing.reduce(
        (sum, entry) => sum + (chunkIndex.get(entry.sha256)?.size ?? 0),
        0,
      );
      let uploaded = 0;
      yield* onProgress({ stage: "uploading", bytesUploaded: 0, bytesTotal: bytesMissing });
      yield* Effect.forEach(
        missing,
        (entry) =>
          Effect.gen(function* () {
            const chunk = chunkIndex.get(entry.sha256);
            if (!chunk) return yield* fail(`Ditto asked for an unknown chunk ${entry.sha256}.`);
            yield* uploadChunk(entry.putUrl, chunk);
            uploaded += chunk.size;
            yield* onProgress({
              stage: "uploading",
              bytesUploaded: uploaded,
              bytesTotal: bytesMissing,
            });
          }),
        { concurrency: UPLOAD_CONCURRENCY, discard: true },
      );

      yield* onProgress({ stage: "committing", detail: `generation ${generation}` });
      const now = yield* DateTime.now;
      const manifest: TeleportManifest = {
        version: 1,
        capsuleId: capsule.id,
        generation,
        parentGeneration,
        createdAt: DateTime.formatIso(now),
        machine: machineInfo(),
        root: { kind: rootKind, name: capsuleName },
        repos: repoManifests,
        harness: {
          kind: harness ?? "none",
          sessionId,
          cwd: root,
          chunks: harnessBytes ? toManifestChunks(harnessBytes) : [],
        },
        excludes: [".env*", ...TELEPORT_EXCLUDED_NAMES],
        totals: {
          chunks: chunks.length,
          bytes: bytesTotal,
          dedupedBytes: bytesTotal - bytesMissing,
        },
      };
      yield* apiPost(
        creds,
        `/api/v5/teleport/capsules/${encodeURIComponent(capsule.id)}/commit`,
        { generation, manifest },
        Schema.Unknown,
      );

      const finalName = capsule.name || capsuleName;
      yield* writeState(input.threadId, {
        capsuleId: capsule.id,
        capsuleName: finalName,
        generation,
        basis: basisTips,
      });

      return {
        capsuleId: capsule.id,
        capsuleName: finalName,
        generation,
        bytes: bytesTotal,
        chunks: chunks.length,
        dedupedChunks: chunks.length - missing.length,
        harness,
        harnessSessionId: sessionId,
      } satisfies TeleportCapsuleSummary;
    }).pipe(Effect.scoped, Effect.withSpan("TeleportService.teleportThread"));

  const launchCloudSession: TeleportService["Service"]["launchCloudSession"] = Effect.fn(
    "TeleportService.launchCloudSession",
  )(function* (input) {
    const creds = yield* requireCredentials;
    const session = yield* apiPost(
      creds,
      `/api/v5/teleport/capsules/${encodeURIComponent(input.capsuleId)}/cloud-sessions`,
      { harness: input.harness },
      CloudSessionRecord,
    );
    return {
      ...session,
      url: `${dittoAppUrlFor(creds.apiBaseUrl)}/chat/${encodeURIComponent(session.threadId)}`,
    } satisfies TeleportCloudSession;
  });

  return TeleportService.of({ teleportThread, launchCloudSession });
});

export const layer = Layer.effect(TeleportService, make);
