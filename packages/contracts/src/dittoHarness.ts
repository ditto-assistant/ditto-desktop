import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const DittoHarnessEmbedder = Schema.Literals(["ollama", "hash"]);
export type DittoHarnessEmbedder = typeof DittoHarnessEmbedder.Type;

export const DittoHarnessChatProvider = Schema.Literals(["ollama", "openrouter", "vllm"]);
export type DittoHarnessChatProvider = typeof DittoHarnessChatProvider.Type;

export const DittoLocalChatProvider = Schema.Literals(["ollama", "vllm"]);
export type DittoLocalChatProvider = typeof DittoLocalChatProvider.Type;

export const DittoHarnessStatusState = Schema.Literals([
  "disabled",
  "ready",
  "unavailable",
  "error",
]);
export type DittoHarnessStatusState = typeof DittoHarnessStatusState.Type;

export const DittoHarnessStatus = Schema.Struct({
  enabled: Schema.Boolean,
  state: DittoHarnessStatusState,
  checkedAt: IsoDateTime,
  databasePath: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
export type DittoHarnessStatus = typeof DittoHarnessStatus.Type;

export const DittoHarnessSubjectInput = Schema.Struct({
  text: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedString),
  key: Schema.optional(Schema.Boolean),
});
export type DittoHarnessSubjectInput = typeof DittoHarnessSubjectInput.Type;

export const DittoHarnessSaveMemoryInput = Schema.Struct({
  prompt: TrimmedNonEmptyString,
  response: TrimmedNonEmptyString,
  summary: Schema.optional(TrimmedString),
  sessionId: Schema.optional(TrimmedString),
  source: Schema.optional(TrimmedString),
  sourceContext: Schema.optional(TrimmedString),
  timestamp: Schema.optional(IsoDateTime),
  timezoneOffset: Schema.optional(Schema.Int),
  subjects: Schema.optional(Schema.Array(DittoHarnessSubjectInput)),
});
export type DittoHarnessSaveMemoryInput = typeof DittoHarnessSaveMemoryInput.Type;

export const DittoHarnessSaveMemoryResult = Schema.Struct({
  memory: Schema.Unknown,
});
export type DittoHarnessSaveMemoryResult = typeof DittoHarnessSaveMemoryResult.Type;

export const DittoHarnessSearchMemoriesInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  sessionId: Schema.optional(TrimmedString),
  limit: Schema.optional(PositiveInt),
  minSimilarity: Schema.optional(Schema.Number),
});
export type DittoHarnessSearchMemoriesInput = typeof DittoHarnessSearchMemoriesInput.Type;

export const DittoHarnessSearchMemoriesResult = Schema.Struct({
  memories: Schema.Array(Schema.Unknown),
});
export type DittoHarnessSearchMemoriesResult = typeof DittoHarnessSearchMemoriesResult.Type;

export const DittoHarnessSearchSubjectsInput = Schema.Struct({
  query: TrimmedNonEmptyString,
  limit: Schema.optional(PositiveInt),
});
export type DittoHarnessSearchSubjectsInput = typeof DittoHarnessSearchSubjectsInput.Type;

export const DittoHarnessSearchSubjectsResult = Schema.Struct({
  subjects: Schema.Array(Schema.Unknown),
});
export type DittoHarnessSearchSubjectsResult = typeof DittoHarnessSearchSubjectsResult.Type;

export const DittoHarnessDreamInput = Schema.Struct({
  maxMemories: Schema.optional(NonNegativeInt),
  refine: Schema.optional(Schema.Boolean),
});
export type DittoHarnessDreamInput = typeof DittoHarnessDreamInput.Type;

export const DittoHarnessDreamResult = Schema.Struct({
  report: Schema.Unknown,
});
export type DittoHarnessDreamResult = typeof DittoHarnessDreamResult.Type;

export const DittoHarnessErrorKind = Schema.Literals([
  "disabled",
  "unavailable",
  "operation_failed",
]);
export type DittoHarnessErrorKind = typeof DittoHarnessErrorKind.Type;

export class DittoHarnessError extends Schema.TaggedErrorClass<DittoHarnessError>()(
  "DittoHarnessError",
  {
    kind: DittoHarnessErrorKind,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
