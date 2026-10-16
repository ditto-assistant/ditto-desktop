import {
  ApprovalRequestId,
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  GrokSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeClaudeAdapter } from "./provider/Layers/ClaudeAdapter.ts";
import { makeCodexAdapter } from "./provider/Layers/CodexAdapter.ts";
import { makeCursorAdapter } from "./provider/Layers/CursorAdapter.ts";
import { makeGrokAdapter } from "./provider/Layers/GrokAdapter.ts";
import type { ProviderAdapterShape } from "./provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "./provider/Errors.ts";

export const DesktopProvider = Schema.Literals(["codex", "claude", "cursor", "grok"]);
export type DesktopProvider = typeof DesktopProvider.Type;

// This is a private parent/child pipe, not a second server or a renderer RPC API.
export const DesktopProviderStart = Schema.Struct({
  type: Schema.Literal("start"),
  provider: DesktopProvider,
  binaryPath: Schema.NonEmptyString,
  stateDir: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  session: ProviderSessionStartInput,
});
export type DesktopProviderStart = typeof DesktopProviderStart.Type;

export class DesktopProviderError extends Schema.TaggedError<DesktopProviderError>()(
  "DesktopProviderError",
  { message: Schema.String },
) {}

const decodeCodex = Schema.decodeEffect(CodexSettings);
const decodeClaude = Schema.decodeEffect(ClaudeSettings);
const decodeCursor = Schema.decodeEffect(CursorSettings);
const decodeGrok = Schema.decodeEffect(GrokSettings);

export const makeDesktopProviderAdapter = Effect.fn("makeDesktopProviderAdapter")(function* (
  provider: DesktopProvider,
  binaryPath: string,
) {
  const settings = { binaryPath };
  switch (provider) {
    case "codex":
      return yield* makeCodexAdapter(yield* decodeCodex(settings));
    case "claude":
      return yield* makeClaudeAdapter(yield* decodeClaude(settings));
    case "cursor":
      return yield* makeCursorAdapter(yield* decodeCursor(settings));
    case "grok":
      return yield* makeGrokAdapter(yield* decodeGrok(settings));
  }
});

export interface DesktopProviderCallbacks {
  readonly event: (event: ProviderRuntimeEvent, live: boolean) => void;
  readonly resume?: (cursor: unknown) => void;
  readonly approve: (
    event: Extract<ProviderRuntimeEvent, { type: "request.opened" }>,
  ) => Effect.Effect<ProviderApprovalDecision, DesktopProviderError>;
}

// Keep the adapters' event stream intact. Ditto owns presentation; provider
// protocol parsing, approval semantics and process lifecycle remain upstream.
export const runDesktopProviderTurn = Effect.fn("runDesktopProviderTurn")(function* (
  adapter: ProviderAdapterShape<ProviderAdapterError>,
  input: DesktopProviderStart,
  callbacks: DesktopProviderCallbacks,
) {
  const finished = yield* Deferred.make<
    { readonly cancelled: boolean },
    DesktopProviderError | ProviderAdapterError
  >();
  const scope = yield* Effect.scope;
  let text = "";
  let submitted = false;
  let turnStarted = false;
  let activeTurnId: string | undefined;
  yield* Effect.addFinalizer(() =>
    adapter
      .interruptTurn(input.session.threadId)
      .pipe(Effect.ignore, Effect.andThen(adapter.stopAll().pipe(Effect.ignore))),
  );
  yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.gen(function* () {
      if (event.threadId !== input.session.threadId) return;
      if (submitted && event.type === "turn.started" && !turnStarted) {
        turnStarted = true;
        activeTurnId = event.turnId;
        const sessions = yield* adapter.listSessions();
        const cursor = sessions.find(
          (session) => session.threadId === input.session.threadId,
        )?.resumeCursor;
        if (cursor) callbacks.resume?.(cursor);
      }
      const live =
        submitted && turnStarted && (event.turnId === undefined || event.turnId === activeTurnId);
      callbacks.event(event, live);
      if (live && event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
        text = (text + event.payload.delta).slice(0, 200000);
      }
      if (event.type === "request.opened" && event.requestId) {
        const requestId = ApprovalRequestId.make(event.requestId);
        yield* callbacks.approve(event).pipe(
          Effect.flatMap((decision) =>
            adapter.respondToRequest(input.session.threadId, requestId, decision),
          ),
          Effect.catch((error) => Deferred.fail(finished, error)),
          Effect.forkIn(scope),
        );
      }
      if (event.type === "user-input.requested") {
        yield* Deferred.fail(
          finished,
          new DesktopProviderError({
            message:
              "This engine needs an interactive answer that this Desktop view cannot collect yet. Use the coding workbench for tasks requiring follow-up questions.",
          }),
        );
      }
      if (live && event.type === "turn.completed") {
        if (event.payload.state === "failed") {
          yield* Deferred.fail(
            finished,
            new DesktopProviderError({
              message: event.payload.errorMessage ?? "Coding agent failed.",
            }),
          );
        } else {
          yield* Deferred.succeed(finished, {
            cancelled: event.payload.state !== "completed",
          });
        }
      }
      if (live && event.type === "turn.aborted") {
        yield* Deferred.succeed(finished, { cancelled: true });
      }
      if (event.type === "session.exited" || event.type === "runtime.error") {
        yield* Deferred.fail(
          finished,
          new DesktopProviderError({
            message:
              event.type === "runtime.error"
                ? event.payload.message
                : (event.payload.reason ?? "Coding agent disconnected before completing its turn."),
          }),
        );
      }
    }),
  ).pipe(
    Effect.andThen(
      Deferred.fail(
        finished,
        new DesktopProviderError({
          message: "Coding event stream closed before completing the task.",
        }),
      ),
    ),
    Effect.catchCause(() =>
      Deferred.fail(
        finished,
        new DesktopProviderError({ message: "Coding event stream stopped unexpectedly." }),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const session = yield* adapter.startSession(input.session);
  if (session.resumeCursor) callbacks.resume?.(session.resumeCursor);
  submitted = true;
  // ACP adapters keep sendTurn open until the native prompt returns. Run it
  // beside the event consumer so a question, disconnect or failure can end
  // the task and release that pending prompt.
  yield* adapter.sendTurn({ threadId: input.session.threadId, input: input.prompt }).pipe(
    Effect.catch((error) => Deferred.fail(finished, error)),
    Effect.forkScoped({ startImmediately: true }),
  );
  const result = yield* Deferred.await(finished);
  const sessions = yield* adapter.listSessions();
  const resumeCursor = sessions.find(
    (session) => session.threadId === input.session.threadId,
  )?.resumeCursor;
  return { ...result, text: text.trim(), resumeCursor };
});
