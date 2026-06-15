import {
  EventId,
  type DittoSettings,
  ProviderDriverKind,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ApprovalRequestId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  dittoModelOptions,
  explainDittoHarnessFailure,
  toDittoHarnessMessage,
  type DittoHarnessOpener,
} from "../../dittoHarness/DittoHarnessRuntime.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("ditto");
const DEFAULT_MAX_TURNS = 8;

interface DittoAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly opener: DittoHarnessOpener;
}

interface SessionState {
  session: ProviderSession;
  snapshot: ProviderThreadSnapshot;
  nextTurnSequence: number;
  activeTurnId: TurnId | undefined;
  interruptedTurnIds: Set<TurnId>;
  stopped: boolean;
}

function providerMismatch(input: ProviderSessionStartInput): ProviderAdapterValidationError | null {
  if (input.provider !== undefined && input.provider !== PROVIDER) {
    return new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation: "startSession",
      issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
    });
  }
  return null;
}

function sessionNotFound(threadId: ThreadId): ProviderAdapterSessionNotFoundError {
  return new ProviderAdapterSessionNotFoundError({
    provider: PROVIDER,
    threadId: String(threadId),
  });
}

function sessionClosed(threadId: ThreadId): ProviderAdapterSessionClosedError {
  return new ProviderAdapterSessionClosedError({
    provider: PROVIDER,
    threadId: String(threadId),
  });
}

function appendAttachmentSummary(input: ProviderSendTurnInput): string {
  const prompt = input.input?.trim() ?? "";
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return prompt;
  }

  const lines = attachments.map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );
  return [prompt, "", "Attachment metadata available to T3 Code for this turn:", ...lines].join(
    "\n",
  );
}

export const makeDittoAdapter = Effect.fn("makeDittoAdapter")(function* (
  settings: DittoSettings,
  options: DittoAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, SessionState>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const emit = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
  const randomUUIDv4 = (operation: string, threadId?: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue: threadId
              ? `Failed to generate Ditto runtime identifier for thread '${threadId}'.`
              : "Failed to generate Ditto runtime identifier.",
            cause,
          }),
      ),
    );
  const eventId = (threadId: ThreadId) =>
    randomUUIDv4("runtimeEvent", threadId).pipe(Effect.map(EventId.make));
  const itemId = (threadId: ThreadId) =>
    randomUUIDv4("runtimeItem", threadId).pipe(Effect.map((id) => RuntimeItemId.make(id)));

  const baseEvent = Effect.fn("DittoAdapter.baseEvent")(function* (
    state: SessionState,
    extra?: {
      readonly turnId?: TurnId | undefined;
      readonly itemId?: RuntimeItemId | undefined;
    },
  ) {
    return {
      eventId: yield* eventId(state.session.threadId),
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId: state.session.threadId,
      createdAt: yield* nowIso,
      ...(extra?.turnId !== undefined ? { turnId: extra.turnId } : {}),
      ...(extra?.itemId !== undefined ? { itemId: extra.itemId } : {}),
    } as const;
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<SessionState, ProviderAdapterError> => {
    const state = sessions.get(threadId);
    if (!state) {
      return Effect.fail(sessionNotFound(threadId));
    }
    if (state.stopped || state.session.status === "closed") {
      return Effect.fail(sessionClosed(threadId));
    }
    return Effect.succeed(state);
  };

  function withoutActiveTurn(session: ProviderSession): Omit<ProviderSession, "activeTurnId"> {
    const { activeTurnId: _activeTurnId, ...rest } = session;
    return rest;
  }

  const completeTurn = Effect.fn("DittoAdapter.completeTurn")(function* (input: {
    readonly state: SessionState;
    readonly turnId: TurnId;
    readonly itemId: RuntimeItemId;
    readonly response: string;
    readonly cost: number;
    readonly toolCalls: ReadonlyArray<string>;
  }) {
    const interrupted = input.state.interruptedTurnIds.has(input.turnId);
    const response = input.response.trim();

    if (response.length > 0) {
      yield* emit({
        ...(yield* baseEvent(input.state, { turnId: input.turnId, itemId: input.itemId })),
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: response,
        },
      });
    }

    if (input.toolCalls.length > 0) {
      yield* emit({
        ...(yield* baseEvent(input.state, { turnId: input.turnId })),
        type: "tool.summary",
        payload: {
          summary: `Ditto memory tools: ${input.toolCalls.join(", ")}`,
        },
      });
    }

    yield* emit({
      ...(yield* baseEvent(input.state, { turnId: input.turnId, itemId: input.itemId })),
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        status: interrupted ? "failed" : "completed",
        ...(response.length > 0 ? { detail: response } : {}),
      },
    });

    yield* emit({
      ...(yield* baseEvent(input.state, { turnId: input.turnId })),
      type: "turn.completed",
      payload: {
        state: interrupted ? "interrupted" : "completed",
        modelUsage: {
          provider: settings.chatProvider,
          model: settings.chatModel,
          cost: input.cost,
          toolCalls: input.toolCalls,
        },
      },
    });

    input.state.session = {
      ...withoutActiveTurn(input.state.session),
      status: "ready",
      updatedAt: yield* nowIso,
    };
    input.state.activeTurnId = undefined;
  });

  const failTurn = Effect.fn("DittoAdapter.failTurn")(function* (input: {
    readonly state: SessionState;
    readonly turnId: TurnId;
    readonly itemId: RuntimeItemId;
    readonly message: string;
  }) {
    yield* emit({
      ...(yield* baseEvent(input.state, { turnId: input.turnId, itemId: input.itemId })),
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        status: "failed",
        detail: input.message,
      },
    });
    yield* emit({
      ...(yield* baseEvent(input.state, { turnId: input.turnId })),
      type: "runtime.error",
      payload: {
        message: input.message,
        class: "provider_error",
      },
    });
    yield* emit({
      ...(yield* baseEvent(input.state, { turnId: input.turnId })),
      type: "turn.completed",
      payload: {
        state: "failed",
        errorMessage: input.message,
      },
    });
    input.state.session = {
      ...withoutActiveTurn(input.state.session),
      status: "error",
      lastError: input.message,
      updatedAt: yield* nowIso,
    };
    input.state.activeTurnId = undefined;
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.gen(function* () {
      const mismatch = providerMismatch(input);
      if (mismatch) {
        return yield* mismatch;
      }

      const createdAt = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        model: input.modelSelection?.model ?? settings.chatModel,
        resumeCursor: input.resumeCursor ?? { provider: PROVIDER, threadId: input.threadId },
        createdAt,
        updatedAt: createdAt,
      };

      const state: SessionState = {
        session,
        snapshot: {
          threadId: input.threadId,
          turns: [],
        },
        nextTurnSequence: 0,
        activeTurnId: undefined,
        interruptedTurnIds: new Set(),
        stopped: false,
      };
      sessions.set(input.threadId, state);

      yield* emit({
        ...(yield* baseEvent(state)),
        type: "session.started",
        payload: {
          message: "Ditto local session started.",
          resume: session.resumeCursor,
        },
      });
      yield* emit({
        ...(yield* baseEvent(state)),
        type: "thread.started",
        payload: {
          providerThreadId: String(input.threadId),
        },
      });
      yield* emit({
        ...(yield* baseEvent(state)),
        type: "session.state.changed",
        payload: {
          state: "ready",
        },
      });

      return session;
    });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const state = yield* requireSession(input.threadId);
      const prompt = appendAttachmentSummary(input).trim();
      if (prompt.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Ditto provider requires non-empty input text.",
        });
      }

      state.nextTurnSequence += 1;
      const turnId = TurnId.make(`ditto-turn-${state.nextTurnSequence}`);
      const assistantItemId = yield* itemId(input.threadId);
      state.activeTurnId = turnId;
      state.session = {
        ...state.session,
        status: "running",
        activeTurnId: turnId,
        model: input.modelSelection?.model ?? settings.chatModel,
        updatedAt: yield* nowIso,
      };

      yield* emit({
        ...(yield* baseEvent(state, { turnId })),
        type: "turn.started",
        payload: {
          model: input.modelSelection?.model ?? settings.chatModel,
        },
      });
      yield* emit({
        ...(yield* baseEvent(state, { turnId, itemId: assistantItemId })),
        type: "item.started",
        payload: {
          itemType: "assistant_message",
          status: "inProgress",
          title: "Ditto",
        },
      });

      const opened = yield* options.opener(settings).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "open",
              detail: cause.message,
              cause,
            }),
        ),
        Effect.catch((error: ProviderAdapterRequestError) =>
          failTurn({
            state,
            turnId,
            itemId: assistantItemId,
            message: error.detail,
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );
      const result = yield* Effect.tryPromise({
        try: () =>
          opened.harness.chat(opened.settings.userId, prompt, {
            ...dittoModelOptions(opened.settings, {
              sessionId: String(input.threadId),
              maxTurns: DEFAULT_MAX_TURNS,
              saveMemory: settings.saveMemory,
            }),
            ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chat",
            detail: explainDittoHarnessFailure(
              `Ditto chat failed: ${toDittoHarnessMessage(cause)}`,
            ),
            cause,
          }),
      }).pipe(
        Effect.catch((error: ProviderAdapterRequestError) =>
          failTurn({
            state,
            turnId,
            itemId: assistantItemId,
            message: error.detail,
          }).pipe(Effect.andThen(Effect.fail(error))),
        ),
      );

      const assistantText = result.response.trim();
      const userItem = {
        type: "userMessage",
        content: [{ type: "text", text: input.input ?? "" }],
      } as const;
      const assistantItem = {
        type: "agentMessage",
        text: assistantText,
        provider: "ditto",
        toolCalls: result.toolCalls,
      } as const;
      const nextTurn: ProviderThreadTurnSnapshot = {
        id: turnId,
        items: [userItem, assistantItem],
      };
      state.snapshot = {
        threadId: state.snapshot.threadId,
        turns: [...state.snapshot.turns, nextTurn],
      };

      yield* completeTurn({
        state,
        turnId,
        itemId: assistantItemId,
        response: assistantText,
        cost: result.cost,
        toolCalls: result.toolCalls,
      });

      return {
        threadId: input.threadId,
        turnId,
        ...(state.session.resumeCursor !== undefined
          ? { resumeCursor: state.session.resumeCursor }
          : {}),
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadId,
    turnId,
  ) =>
    Effect.gen(function* () {
      const state = yield* requireSession(threadId);
      const activeTurnId = turnId ?? state.activeTurnId;
      if (activeTurnId === undefined) {
        return;
      }
      state.interruptedTurnIds.add(activeTurnId);
      yield* emit({
        ...(yield* baseEvent(state, { turnId: activeTurnId })),
        type: "turn.aborted",
        payload: {
          reason: "Interrupted by user.",
        },
      });
    });

  const unsupportedRequest = (
    operation: string,
    threadId: ThreadId,
  ): Effect.Effect<never, ProviderAdapterError> =>
    requireSession(threadId).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation,
            issue: "Ditto provider does not support interactive approval requests yet.",
          }),
        ),
      ),
    );

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
    threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ) => unsupportedRequest("respondToRequest", threadId);

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ) => unsupportedRequest("respondToUserInput", threadId);

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const state = sessions.get(threadId);
      if (!state) return;
      state.stopped = true;
      state.session = {
        ...withoutActiveTurn(state.session),
        status: "closed",
        updatedAt: yield* nowIso,
      };
      yield* emit({
        ...(yield* baseEvent(state)),
        type: "session.exited",
        payload: {
          reason: "Stopped by T3 Code.",
          exitKind: "graceful",
        },
      });
      sessions.delete(threadId);
    });

  const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (state) => state.session));

  const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
    Effect.succeed(sessions.has(threadId));

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
    requireSession(threadId).pipe(Effect.map((state) => state.snapshot));

  const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
    threadId,
    numTurns,
  ) =>
    Effect.gen(function* () {
      const state = yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > state.snapshot.turns.length) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer between 0 and current turn count.",
        });
      }
      state.snapshot = {
        threadId: state.snapshot.threadId,
        turns: state.snapshot.turns.slice(0, state.snapshot.turns.length - numTurns),
      };
      return state.snapshot;
    });

  const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
    Effect.sync(() => {
      sessions.clear();
    });

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEvents),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
