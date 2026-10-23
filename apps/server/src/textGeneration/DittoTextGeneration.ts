import { type DittoSettings, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import {
  dittoActionModelOptions,
  explainDittoHarnessFailure,
  toDittoHarnessMessage,
  type DittoHarnessOpener,
} from "../dittoHarness/DittoHarnessRuntime.ts";

// DITTO: upstream moved prompt building and sanitizing into provider-core's
// `fromRunner`; Ditto supplies only the runner that asks the local harness.
export const makeDittoTextGeneration = Effect.fn("makeDittoTextGeneration")(function* (
  settings: DittoSettings,
  opener: DittoHarnessOpener,
) {
  yield* Effect.void;

  const runDittoJson: TextGenerationOperations.Runner = Effect.fn(
    "DittoTextGeneration.runDittoJson",
  )(function* (request) {
    const opened = yield* opener(settings).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation: request.operation,
            detail: cause.message,
            cause,
          }),
      ),
    );
    const result = yield* Effect.tryPromise({
      try: () =>
        opened.harness.chat(
          opened.settings.userId,
          [request.prompt, "", "Return only valid JSON. Do not wrap it in markdown fences."].join(
            "\n",
          ),
          {
            ...dittoActionModelOptions(opened.settings, {
              sessionId: `__t3_${request.operation}__`,
              maxTurns: 1,
              saveMemory: false,
            }),
          },
        ),
      catch: (cause) =>
        new TextGenerationError({
          operation: request.operation,
          detail: explainDittoHarnessFailure(
            `Ditto text generation failed: ${toDittoHarnessMessage(cause)}`,
          ),
          cause,
        }),
    });
    return yield* TextGenerationOperations.decodeJsonReply(request, "Ditto", result.response);
  });

  return TextGenerationOperations.fromRunner(
    "DittoTextGeneration",
    TextGenerationOperations.withoutInvestigation("Ditto", runDittoJson),
  );
});
