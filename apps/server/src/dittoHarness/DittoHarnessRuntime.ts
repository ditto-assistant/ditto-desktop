import { DittoHarnessError, type DittoHarnessSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

import type { ServerConfig } from "../config.ts";

type ServerConfigShape = ServerConfig["Service"];

export interface NativeHarness {
  readonly seedUser: (uid: string) => Promise<void>;
  readonly saveMemory: (json: unknown) => Promise<unknown>;
  readonly searchMemories: (
    uid: string,
    query: string,
    opts?: {
      readonly sessionId?: string;
      readonly limit?: number;
      readonly minSimilarity?: number;
    },
  ) => Promise<ReadonlyArray<unknown>>;
  readonly searchSubjects: (uid: string, query: string) => Promise<ReadonlyArray<unknown>>;
  readonly dream: (uid: string, opts?: DittoHarnessModelOptions) => Promise<unknown>;
  readonly chat: (
    uid: string,
    message: string,
    opts?: DittoHarnessModelOptions,
  ) => Promise<DittoHarnessChatTurnResult>;
}

export interface NativeHarnessModule {
  readonly Harness: {
    readonly open: (
      dbPath: string,
      opts?: {
        readonly ollamaBaseUrl?: string;
        readonly embedder?: string;
      },
    ) => Promise<NativeHarness>;
  };
  readonly harnessVersion?: () => string;
}

export interface DittoHarnessModelOptions {
  readonly provider?: string;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly sessionId?: string;
  readonly maxTurns?: number;
  readonly saveMemory?: boolean;
  readonly maxMemories?: number;
  readonly refine?: boolean;
}

export interface DittoHarnessChatTurnResult {
  readonly response: string;
  readonly cost: number;
  readonly toolCalls: ReadonlyArray<string>;
}

export interface OpenHarness<Settings extends DittoRuntimeSettings = DittoRuntimeSettings> {
  readonly key: string;
  readonly databasePath: string;
  readonly settings: Settings;
  readonly harness: NativeHarness;
  readonly version: string | undefined;
}

export type DittoRuntimeSettings = Pick<
  DittoHarnessSettings,
  | "enabled"
  | "userId"
  | "databasePath"
  | "embedder"
  | "ollamaBaseUrl"
  | "chatProvider"
  | "chatModel"
  | "chatBaseUrl"
  | "actionProvider"
  | "actionModel"
  | "actionBaseUrl"
> & {
  readonly saveMemory?: boolean;
};

const requireFromHere = NodeModule.createRequire(import.meta.url);

export function toDittoHarnessMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return String(cause);
}

export function explainDittoHarnessFailure(message: string): string {
  if (message.includes("does not support tools")) {
    return [
      message,
      "The Ditto provider uses the harness memory tools, so the configured Ollama model must support tool calling.",
      "Use a tools-capable local model such as qwen3:4b, then run `ollama pull qwen3:4b`.",
    ].join(" ");
  }
  return message;
}

export function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function dittoHarnessError(
  kind: DittoHarnessError["kind"],
  message: string,
  cause?: unknown,
) {
  return new DittoHarnessError({
    kind,
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function resolveDittoDatabasePath(input: {
  readonly path: Path.Path;
  readonly config: ServerConfigShape;
  readonly settings: Pick<DittoRuntimeSettings, "databasePath">;
}): string {
  const configured = trimToUndefined(input.settings.databasePath);
  if (!configured) {
    return input.path.join(input.config.stateDir, "ditto-harness.sqlite");
  }
  return input.path.isAbsolute(configured)
    ? configured
    : input.path.resolve(input.config.stateDir, configured);
}

function nativeLoadCandidates(path: Path.Path): ReadonlyArray<string> {
  const explicit = trimToUndefined(process.env.DITTO_HARNESS_NODE_PATH);
  if (explicit) {
    return [explicit];
  }

  const currentDir = path.dirname(NodeURL.fileURLToPath(import.meta.url));
  return [
    "@ditto/harness-node",
    path.resolve(process.cwd(), "../ditto-harness/rust/crates/node"),
    path.resolve(currentDir, "../../../../../ditto-harness/rust/crates/node"),
  ];
}

export function loadDittoNativeModule(path: Path.Path): NativeHarnessModule {
  const failures: string[] = [];
  for (const candidate of nativeLoadCandidates(path)) {
    try {
      const loaded = requireFromHere(candidate) as unknown;
      if (
        loaded &&
        typeof loaded === "object" &&
        "Harness" in loaded &&
        typeof (loaded as NativeHarnessModule).Harness?.open === "function"
      ) {
        return loaded as NativeHarnessModule;
      }
      failures.push(`${candidate}: module did not export Harness.open`);
    } catch (cause) {
      failures.push(`${candidate}: ${toDittoHarnessMessage(cause)}`);
    }
  }
  throw new Error(
    [
      "Ditto Harness native binding is unavailable.",
      "Build ../ditto-harness/rust/crates/node or set DITTO_HARNESS_NODE_PATH.",
      ...failures.map((failure) => `- ${failure}`),
    ].join("\n"),
  );
}

function cacheKey(input: {
  readonly databasePath: string;
  readonly settings: DittoRuntimeSettings;
}): string {
  return JSON.stringify({
    databasePath: input.databasePath,
    userId: input.settings.userId,
    embedder: input.settings.embedder,
    ollamaBaseUrl: input.settings.ollamaBaseUrl,
    chatProvider: input.settings.chatProvider,
    chatModel: input.settings.chatModel,
    chatBaseUrl: input.settings.chatBaseUrl,
    actionProvider: input.settings.actionProvider,
    actionModel: input.settings.actionModel,
    actionBaseUrl: input.settings.actionBaseUrl,
    saveMemory: input.settings.saveMemory,
  });
}

export function dittoModelOptions(
  settings: Pick<DittoRuntimeSettings, "chatProvider" | "chatModel" | "chatBaseUrl" | "saveMemory">,
  extra?: Omit<DittoHarnessModelOptions, "provider" | "model" | "baseUrl">,
): DittoHarnessModelOptions {
  const model = trimToUndefined(settings.chatModel);
  const baseUrl = trimToUndefined(settings.chatBaseUrl);
  return {
    provider: settings.chatProvider,
    ...(typeof settings.saveMemory === "boolean" ? { saveMemory: settings.saveMemory } : {}),
    ...extra,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function dittoActionModelOptions(
  settings: Pick<
    DittoRuntimeSettings,
    | "chatProvider"
    | "chatModel"
    | "chatBaseUrl"
    | "actionProvider"
    | "actionModel"
    | "actionBaseUrl"
    | "saveMemory"
  >,
  extra?: Omit<DittoHarnessModelOptions, "provider" | "model" | "baseUrl">,
): DittoHarnessModelOptions {
  const provider = settings.actionProvider ?? settings.chatProvider;
  const model = trimToUndefined(settings.actionModel) ?? trimToUndefined(settings.chatModel);
  const canUseChatBaseUrl =
    settings.actionProvider === undefined || settings.actionProvider === settings.chatProvider;
  const baseUrl =
    trimToUndefined(settings.actionBaseUrl) ??
    (canUseChatBaseUrl ? trimToUndefined(settings.chatBaseUrl) : undefined);
  return {
    provider,
    ...(typeof settings.saveMemory === "boolean" ? { saveMemory: settings.saveMemory } : {}),
    ...extra,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function makeDittoHarnessOpener(input: {
  readonly config: ServerConfigShape;
  readonly path: Path.Path;
}) {
  const cached = new Map<string, OpenHarness>();

  return <Settings extends DittoRuntimeSettings>(
    settings: Settings,
  ): Effect.Effect<OpenHarness<Settings>, DittoHarnessError> =>
    Effect.gen(function* () {
      const databasePath = resolveDittoDatabasePath({
        path: input.path,
        config: input.config,
        settings,
      });
      if (!settings.enabled) {
        return yield* dittoHarnessError("disabled", "Ditto Harness is disabled.");
      }

      const key = cacheKey({ databasePath, settings });
      const cachedHarness = cached.get(key);
      if (cachedHarness !== undefined) {
        return cachedHarness as OpenHarness<Settings>;
      }

      const opened = yield* Effect.tryPromise({
        try: async () => {
          const native = loadDittoNativeModule(input.path);
          const openOptions: {
            readonly embedder?: string;
            readonly ollamaBaseUrl?: string;
          } = {
            embedder: settings.embedder,
          };
          const ollamaBaseUrl = trimToUndefined(settings.ollamaBaseUrl);
          const harness = await native.Harness.open(
            databasePath,
            ollamaBaseUrl ? { ...openOptions, ollamaBaseUrl } : openOptions,
          );
          await harness.seedUser(settings.userId);
          return {
            key,
            settings,
            databasePath,
            harness,
            version: native.harnessVersion?.(),
          } satisfies OpenHarness<Settings>;
        },
        catch: (cause) =>
          dittoHarnessError(
            "unavailable",
            `Failed to open Ditto Harness: ${toDittoHarnessMessage(cause)}`,
            cause,
          ),
      });
      cached.set(key, opened);
      return opened;
    });
}

export type DittoHarnessOpener = ReturnType<typeof makeDittoHarnessOpener>;
