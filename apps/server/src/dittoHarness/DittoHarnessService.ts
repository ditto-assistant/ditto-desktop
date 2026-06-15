import {
  DEFAULT_SERVER_SETTINGS,
  DittoHarnessError,
  type DittoHarnessDreamInput,
  type DittoHarnessDreamResult,
  type DittoHarnessSaveMemoryInput,
  type DittoHarnessSaveMemoryResult,
  type DittoHarnessSearchMemoriesInput,
  type DittoHarnessSearchMemoriesResult,
  type DittoHarnessSearchSubjectsInput,
  type DittoHarnessSearchSubjectsResult,
  type DittoHarnessSettings,
  type DittoHarnessStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  dittoActionModelOptions,
  dittoHarnessError,
  makeDittoHarnessOpener,
  resolveDittoDatabasePath,
  toDittoHarnessMessage,
} from "./DittoHarnessRuntime.ts";

type ServerConfigShape = ServerConfig["Service"];

export interface DittoHarnessPromptContextInput {
  readonly userInput: string;
  readonly sessionId?: string | undefined;
}

export interface DittoHarnessServiceShape {
  readonly status: Effect.Effect<DittoHarnessStatus>;
  readonly saveMemory: (
    input: DittoHarnessSaveMemoryInput,
  ) => Effect.Effect<DittoHarnessSaveMemoryResult, DittoHarnessError>;
  readonly searchMemories: (
    input: DittoHarnessSearchMemoriesInput,
  ) => Effect.Effect<DittoHarnessSearchMemoriesResult, DittoHarnessError>;
  readonly searchSubjects: (
    input: DittoHarnessSearchSubjectsInput,
  ) => Effect.Effect<DittoHarnessSearchSubjectsResult, DittoHarnessError>;
  readonly dream: (
    input: DittoHarnessDreamInput,
  ) => Effect.Effect<DittoHarnessDreamResult, DittoHarnessError>;
  readonly buildPromptContext: (
    input: DittoHarnessPromptContextInput,
  ) => Effect.Effect<string | null>;
}

export class DittoHarnessService extends Context.Service<
  DittoHarnessService,
  DittoHarnessServiceShape
>()("t3/dittoHarness/DittoHarnessService") {}

export const DittoHarnessServiceDisabled = Layer.succeed(
  DittoHarnessService,
  DittoHarnessService.of({
    status: Effect.map(DateTime.now, (now) => ({
      enabled: false,
      state: "disabled" as const,
      checkedAt: DateTime.formatIso(now),
      message: "Ditto Harness is disabled.",
    })),
    saveMemory: () =>
      Effect.fail(
        new DittoHarnessError({
          kind: "disabled",
          message: "Ditto Harness is disabled.",
        }),
      ),
    searchMemories: () => Effect.succeed({ memories: [] }),
    searchSubjects: () => Effect.succeed({ subjects: [] }),
    dream: () =>
      Effect.fail(
        new DittoHarnessError({
          kind: "disabled",
          message: "Ditto Harness dream is disabled.",
        }),
      ),
    buildPromptContext: () => Effect.succeed(null),
  }),
);

function toMessage(cause: unknown): string {
  return toDittoHarnessMessage(cause);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function formatMemoryPreview(memory: unknown, index: number): string {
  const id = readStringField(memory, "id");
  const title = readStringField(memory, "title");
  const summary = readStringField(memory, "summary");
  const prompt = readStringField(memory, "prompt");
  const response = readStringField(memory, "response");
  const parts = [
    `${index + 1}. ${title ?? id ?? "Memory"}`,
    summary ? `summary: ${truncate(summary, 360)}` : undefined,
    prompt ? `user: ${truncate(prompt, 420)}` : undefined,
    response ? `assistant: ${truncate(response, 420)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join("\n");
}

function resolvedDatabasePath(
  path: Path.Path,
  config: ServerConfigShape,
  settings: DittoHarnessSettings,
): string {
  return resolveDittoDatabasePath({
    path,
    config,
    settings,
  });
}

function modelOptions(settings: DittoHarnessSettings) {
  return dittoActionModelOptions(settings);
}

function harnessError(kind: DittoHarnessError["kind"], message: string, cause?: unknown) {
  return dittoHarnessError(kind, message, cause);
}

const makeDittoHarnessService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettingsService;
  const path = yield* Path.Path;
  const openHarnessForSettings = makeDittoHarnessOpener({ config, path });

  const checkedAt = Effect.map(DateTime.now, DateTime.formatIso);
  const readSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.dittoHarness),
    Effect.mapError((cause) =>
      harnessError(
        "operation_failed",
        `Failed to read Ditto Harness settings: ${toMessage(cause)}`,
        cause,
      ),
    ),
  );

  const openHarness = Effect.fn("DittoHarnessService.openHarness")(function* () {
    const settings = yield* readSettings;
    return yield* openHarnessForSettings(settings);
  });

  return {
    status: Effect.gen(function* () {
      const now = yield* checkedAt;
      const settingsResult = yield* Effect.result(readSettings);
      if (Result.isFailure(settingsResult)) {
        return {
          enabled: false,
          state: "error",
          checkedAt: now,
          databasePath: resolvedDatabasePath(path, config, DEFAULT_SERVER_SETTINGS.dittoHarness),
          message: settingsResult.failure.message,
        } satisfies DittoHarnessStatus;
      }

      const settings = settingsResult.success;
      const databasePath = resolvedDatabasePath(path, config, settings);
      if (!settings.enabled) {
        return {
          enabled: false,
          state: "disabled",
          checkedAt: now,
          databasePath,
          message: "Ditto Harness is disabled.",
        } satisfies DittoHarnessStatus;
      }

      const opened = yield* Effect.result(openHarness());
      if (Result.isFailure(opened)) {
        return {
          enabled: true,
          state: opened.failure.kind === "unavailable" ? "unavailable" : "error",
          checkedAt: now,
          databasePath,
          message: opened.failure.message,
        } satisfies DittoHarnessStatus;
      }

      return {
        enabled: true,
        state: "ready",
        checkedAt: now,
        databasePath,
        ...(opened.success.version ? { version: opened.success.version } : {}),
      } satisfies DittoHarnessStatus;
    }),

    saveMemory: (input) =>
      Effect.gen(function* () {
        const opened = yield* openHarness();
        const memory = yield* Effect.tryPromise({
          try: () =>
            opened.harness.saveMemory({
              userId: opened.settings.userId,
              prompt: input.prompt,
              response: input.response,
              summary: input.summary ?? "",
              sessionId: input.sessionId ?? "",
              source: input.source ?? "t3-code",
              sourceContext: input.sourceContext ?? "",
              timestamp: input.timestamp,
              timezoneOffset: input.timezoneOffset ?? 0,
              subjects: input.subjects ?? [],
            }),
          catch: (cause) =>
            harnessError(
              "operation_failed",
              `Failed to save Ditto memory: ${toMessage(cause)}`,
              cause,
            ),
        });
        return { memory };
      }),

    searchMemories: (input) =>
      Effect.gen(function* () {
        const opened = yield* openHarness();
        const memories = yield* Effect.tryPromise({
          try: () =>
            opened.harness.searchMemories(opened.settings.userId, input.query, {
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              ...(input.limit !== undefined ? { limit: input.limit } : {}),
              ...(input.minSimilarity !== undefined ? { minSimilarity: input.minSimilarity } : {}),
            }),
          catch: (cause) =>
            harnessError(
              "operation_failed",
              `Failed to search Ditto memories: ${toMessage(cause)}`,
              cause,
            ),
        });
        return { memories };
      }),

    searchSubjects: (input) =>
      Effect.gen(function* () {
        const opened = yield* openHarness();
        const subjects = yield* Effect.tryPromise({
          try: () => opened.harness.searchSubjects(opened.settings.userId, input.query),
          catch: (cause) =>
            harnessError(
              "operation_failed",
              `Failed to search Ditto subjects: ${toMessage(cause)}`,
              cause,
            ),
        });
        return {
          subjects: input.limit !== undefined ? subjects.slice(0, input.limit) : subjects,
        };
      }),

    dream: (input) =>
      Effect.gen(function* () {
        const opened = yield* openHarness();
        if (!opened.settings.dreamEnabled) {
          return yield* harnessError("disabled", "Ditto Harness dream is disabled.");
        }
        const report = yield* Effect.tryPromise({
          try: () =>
            opened.harness.dream(opened.settings.userId, {
              ...modelOptions(opened.settings),
              ...(input.maxMemories !== undefined ? { maxMemories: input.maxMemories } : {}),
              ...(input.refine !== undefined ? { refine: input.refine } : {}),
            }),
          catch: (cause) =>
            harnessError(
              "operation_failed",
              `Failed to run Ditto Harness dream: ${toMessage(cause)}`,
              cause,
            ),
        });
        return { report };
      }),

    buildPromptContext: (input) =>
      Effect.gen(function* () {
        const settingsResult = yield* Effect.result(readSettings);
        if (Result.isFailure(settingsResult)) {
          yield* Effect.logWarning("failed to read Ditto Harness settings for prompt context", {
            detail: settingsResult.failure.message,
          });
          return null;
        }

        const settings = settingsResult.success;
        if (!settings.enabled || !settings.enablePromptContext || input.userInput.trim() === "") {
          return null;
        }

        const result = yield* Effect.result(
          openHarness().pipe(
            Effect.flatMap((opened) =>
              Effect.tryPromise({
                try: () =>
                  opened.harness.searchMemories(opened.settings.userId, input.userInput, {
                    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
                    limit: opened.settings.promptContextLimit,
                  }),
                catch: (cause) =>
                  harnessError(
                    "operation_failed",
                    `Failed to build Ditto memory context: ${toMessage(cause)}`,
                    cause,
                  ),
              }),
            ),
          ),
        );

        if (Result.isFailure(result)) {
          yield* Effect.logWarning("failed to build Ditto Harness prompt context", {
            detail: result.failure.message,
          });
          return null;
        }
        if (result.success.length === 0) {
          return null;
        }

        return [
          "Relevant memory context for this turn:",
          result.success.map(formatMemoryPreview).join("\n\n"),
        ].join("\n");
      }),
  } satisfies DittoHarnessServiceShape;
});

export const DittoHarnessServiceLive = Layer.effect(DittoHarnessService, makeDittoHarnessService);
