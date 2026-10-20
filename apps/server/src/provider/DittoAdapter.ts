// DITTO: branding — upstream's "T3 Code" strings read "Ditto" here.
/**
 * Orchestration-v2 adapter for the local Ditto harness.
 *
 * DITTO: upstream replaced the per-session `ProviderAdapterShape` (runtime
 * events) with `ProviderAdapterV2` (provider threads, turns and turn items).
 * The harness is request/response, so each turn publishes a running provider
 * turn, then one assistant message and a terminal once `harness.chat` returns.
 */
import {
  type DittoSettings,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  type ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure, makeProviderFailureTurnItem } from "@t3tools/provider-core/server/failure";
import {
  dittoModelOptions,
  explainDittoHarnessFailure,
  toDittoHarnessMessage,
  type DittoHarnessOpener,
} from "../dittoHarness/DittoHarnessRuntime.ts";

const PROVIDER = ProviderDriverKind.make("ditto");
const DEFAULT_MAX_TURNS = 8;

export const DittoProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    canForkThread: false,
  },
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    supportsSteeringByInterruptRestart: false,
  },
  streaming: {
    ...AcpProviderCapabilitiesV2.streaming,
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
  },
  approvals: {
    ...AcpProviderCapabilitiesV2.approvals,
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
  },
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    emitsPlanUpdated: false,
    emitsTodoList: false,
    supportsStructuredQuestions: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface DittoAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly opener: DittoHarnessOpener;
}

function appendAttachmentSummary(message: ProviderAdapter.ProviderAdapterV2TurnMessage): string {
  const prompt = message.text.trim();
  if (message.attachments.length === 0) {
    return prompt;
  }
  const lines = message.attachments.map(
    (attachment) => `- ${attachment.name} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
  );
  return [prompt, "", "Attachment metadata available to Ditto for this turn:", ...lines].join("\n");
}

const protocolError = (detail: string, cause?: unknown) =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver: PROVIDER,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export const makeDittoAdapter = Effect.fn("makeDittoAdapter")(function* (
  settings: DittoSettings,
  options: DittoAdapterOptions,
) {
  yield* Effect.void;

  const openSession: ProviderAdapter.ProviderAdapterV2["Service"]["openSession"] = (
    sessionInput,
  ) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      const providerSession: OrchestrationV2ProviderSession = {
        id: sessionInput.providerSessionId,
        driver: PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
        model: sessionInput.modelSelection.model,
        capabilities: DittoProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      // Provider turns per provider thread, kept for rollback snapshots.
      const turnsByThread = new Map<ProviderThreadId, OrchestrationV2ProviderTurn[]>();
      const activeTurns = new Map<
        ProviderTurnId,
        { readonly fiber: Fiber.Fiber<void>; readonly publishInterrupted: Effect.Effect<void> }
      >();

      const publish = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        PubSub.publish(events, event).pipe(Effect.asVoid);

      const recordTurn = (turn: OrchestrationV2ProviderTurn) =>
        Effect.sync(() => {
          const turns = turnsByThread.get(turn.providerThreadId) ?? [];
          const index = turns.findIndex((candidate) => candidate.id === turn.id);
          if (index === -1) turns.push(turn);
          else turns[index] = turn;
          turnsByThread.set(turn.providerThreadId, turns);
        });

      const startTurn: ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"] = (turnInput) =>
        Effect.gen(function* () {
          const prompt = appendAttachmentSummary(turnInput.message);
          if (prompt.length === 0) {
            return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
              driver: PROVIDER,
              threadId: turnInput.threadId,
              providerThreadId: turnInput.providerThread.id,
              runId: turnInput.runId,
              cause: protocolError("Ditto provider requires non-empty input text."),
            });
          }
          const startedAt = yield* DateTime.now;
          const providerTurnId = ProviderTurnId.make(
            `provider-turn:ditto:${turnInput.threadId}:${turnInput.runOrdinal}:${turnInput.attemptId}`,
          );
          const runningTurn: OrchestrationV2ProviderTurn = {
            id: providerTurnId,
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: null,
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt,
            completedAt: null,
          };
          yield* recordTurn(runningTurn);
          yield* publish({ type: "provider_turn.updated", driver: PROVIDER, providerTurn: runningTurn });

          const finish = (
            status: "completed" | "interrupted" | "failed",
            body:
              | { readonly kind: "assistant"; readonly text: string }
              | { readonly kind: "failure"; readonly message: string; readonly cause?: unknown },
          ) =>
            Effect.gen(function* () {
              const completedAt = yield* DateTime.now;
              const finalTurn: OrchestrationV2ProviderTurn = {
                ...runningTurn,
                status,
                completedAt,
              };
              yield* recordTurn(finalTurn);
              if (body.kind === "assistant" && body.text.length > 0) {
                yield* publish({
                  type: "turn_item.updated",
                  driver: PROVIDER,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:ditto:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status,
                    title: null,
                    startedAt,
                    completedAt,
                    updatedAt: completedAt,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:ditto:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: body.text,
                    streaming: false,
                  },
                });
              }
              yield* publish({ type: "provider_turn.updated", driver: PROVIDER, providerTurn: finalTurn });
              if (body.kind === "failure") {
                const failure = makeProviderFailure({
                  message: body.message,
                  class: "provider_error",
                  ...(body.cause === undefined ? {} : { cause: body.cause }),
                });
                const failureItemOrdinal = turnInput.runOrdinal * 100 + 2;
                yield* publish({
                  type: "turn_item.updated",
                  driver: PROVIDER,
                  turnItem: makeProviderFailureTurnItem({
                    driver: PROVIDER,
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    itemOrdinal: failureItemOrdinal,
                    failure,
                    occurredAt: completedAt,
                  }),
                });
                yield* publish({
                  type: "turn.terminal",
                  driver: PROVIDER,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "failed",
                  failureItemOrdinal,
                  failure,
                  threadDisposition: "reusable",
                });
                return;
              }
              yield* publish({
                type: "turn.terminal",
                driver: PROVIDER,
                providerThreadId: turnInput.providerThread.id,
                providerTurnId,
                runOrdinal: turnInput.runOrdinal,
                status: status === "failed" ? "completed" : status,
                failure: null,
                threadDisposition: "reusable",
              });
            });

          const run = Effect.gen(function* () {
            const opened = yield* options.opener(settings).pipe(
              Effect.mapError((cause) => ({ message: cause.message, cause })),
            );
            const model = turnInput.modelSelection.model || settings.chatModel;
            const result = yield* Effect.tryPromise({
              try: () =>
                opened.harness.chat(opened.settings.userId, prompt, {
                  ...dittoModelOptions(opened.settings, {
                    sessionId: String(turnInput.threadId),
                    maxTurns: DEFAULT_MAX_TURNS,
                    saveMemory: settings.saveMemory,
                  }),
                  ...(model ? { model } : {}),
                }),
              catch: (cause) => ({
                message: explainDittoHarnessFailure(
                  `Ditto chat failed: ${toDittoHarnessMessage(cause)}`,
                ),
                cause,
              }),
            });
            yield* finish("completed", { kind: "assistant", text: result.response.trim() });
          }).pipe(
            Effect.catch((error) =>
              finish("failed", { kind: "failure", message: error.message, cause: error.cause }),
            ),
            Effect.ensuring(Effect.sync(() => activeTurns.delete(providerTurnId))),
          );

          const fiber = yield* run.pipe(Effect.forkIn(scope));
          activeTurns.set(providerTurnId, {
            fiber,
            publishInterrupted: finish("interrupted", { kind: "assistant", text: "" }),
          });
        });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: PROVIDER,
        providerSessionId: sessionInput.providerSessionId,
        providerSession,
        events: Stream.fromPubSub(events),
        ensureThread: (threadInput) =>
          Effect.gen(function* () {
            if (threadInput.existingProviderThread !== undefined) {
              return threadInput.existingProviderThread;
            }
            const createdAt = yield* DateTime.now;
            const nativeThreadId = `ditto:${threadInput.threadId}`;
            return {
              id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
              driver: PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: sessionInput.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver: PROVIDER, nativeId: nativeThreadId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              contextUsage: null,
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            } satisfies OrchestrationV2ProviderThread;
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn,
        steerTurn: (steerInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: PROVIDER,
              providerThreadId: steerInput.providerThread.id,
            }),
          ),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const active = activeTurns.get(interruptInput.providerTurnId);
            if (active === undefined) return;
            activeTurns.delete(interruptInput.providerTurnId);
            yield* Fiber.interrupt(active.fiber);
            yield* active.publishInterrupted;
          }),
        respondToRuntimeRequest: () =>
          Effect.fail(protocolError("Ditto provider does not support interactive requests yet.")),
        readThreadSnapshot: ({ providerThread }) =>
          Effect.succeed({
            providerThread,
            providerTurns: turnsByThread.get(providerThread.id) ?? [],
            messages: [],
            runtimeRequests: [],
          }),
        rollbackThread: ({ providerThread, target }) =>
          Effect.sync(() => {
            // The harness keeps its own memory; rollback trims the turns this
            // session reports so the next turn continues from the target.
            const keepThrough = target.type === "thread_start" ? 0 : target.providerTurn.ordinal;
            const kept = (turnsByThread.get(providerThread.id) ?? []).filter(
              (turn) => turn.ordinal <= keepThrough,
            );
            turnsByThread.set(providerThread.id, kept);
            return { providerThread, providerTurns: kept, messages: [], runtimeRequests: [] };
          }),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: PROVIDER,
              providerThreadId: forkInput.sourceProviderThread.id,
              cause: protocolError("Ditto provider does not support forking threads."),
            }),
          ),
      };
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() =>
          Effect.forEach([...activeTurns.values()], (active) => Fiber.interrupt(active.fiber), {
            discard: true,
          }),
        ),
      );
      return runtime;
    });

  return {
    instanceId: options.instanceId,
    driver: PROVIDER,
    getCapabilities: () => Effect.succeed(DittoProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession,
  } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
});
