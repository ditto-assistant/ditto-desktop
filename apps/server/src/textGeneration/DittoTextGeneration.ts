import { type DittoSettings, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import {
  dittoActionModelOptions,
  explainDittoHarnessFailure,
  toDittoHarnessMessage,
  type DittoHarnessOpener,
} from "../dittoHarness/DittoHarnessRuntime.ts";
import type { TextGenerationShape } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) {
      return candidate;
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

export const makeDittoTextGeneration = Effect.fn("makeDittoTextGeneration")(function* (
  settings: DittoSettings,
  opener: DittoHarnessOpener,
) {
  yield* Effect.void;

  const runDittoJson = Effect.fn("DittoTextGeneration.runDittoJson")(function* <
    S extends Schema.Top,
  >(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly prompt: string;
    readonly outputSchema: S;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const opened = yield* opener(settings).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: cause.message,
            cause,
          }),
      ),
    );
    const result = yield* Effect.tryPromise({
      try: () =>
        opened.harness.chat(
          opened.settings.userId,
          [input.prompt, "", "Return only valid JSON. Do not wrap it in markdown fences."].join(
            "\n",
          ),
          {
            ...dittoActionModelOptions(opened.settings, {
              sessionId: `__t3_${input.operation}__`,
              maxTurns: 1,
              saveMemory: false,
            }),
          },
        ),
      catch: (cause) =>
        new TextGenerationError({
          operation: input.operation,
          detail: explainDittoHarnessFailure(
            `Ditto text generation failed: ${toDittoHarnessMessage(cause)}`,
          ),
          cause,
        }),
    });

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
    return yield* decodeOutput(extractJsonObject(result.response)).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: input.operation,
            detail: "Ditto returned invalid structured JSON.",
            cause,
          }),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "DittoTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runDittoJson({
      operation: "generateCommitMessage",
      prompt,
      outputSchema,
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "DittoTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    const generated = yield* runDittoJson({
      operation: "generatePrContent",
      prompt,
      outputSchema,
    });
    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "DittoTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runDittoJson({
      operation: "generateBranchName",
      prompt,
      outputSchema,
    });
    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "DittoTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const generated = yield* runDittoJson({
      operation: "generateThreadTitle",
      prompt,
      outputSchema,
    });
    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
