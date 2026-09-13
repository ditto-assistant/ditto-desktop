/**
 * `HostBridgeRuntime` on top of t3code's orchestration engine: every
 * non-archived Claude Code / Codex thread is a session; turns, commands,
 * interrupts and prompt answers are orchestration commands; prompts come
 * from the pending-approval projection; checkpoints resolve to the thread's
 * latest checkpoint ref until the Teleport service (feat/teleport) lands.
 *
 * @module remote/OrchestrationHostBridgeRuntime
 */
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionCheckpointRepository } from "../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepository } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadSessionRepository } from "../persistence/Services/ProjectionThreadSessions.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { eventThreadId } from "../relay/AgentAwarenessRelay.ts";
import {
  approvalDecisionForAnswer,
  commandsFromProviderSnapshot,
  harnessForProvider,
  HostBridgeRuntime,
  HostBridgeRuntimeError,
  parsePromptId,
  PERMISSION_PROMPT_OPTIONS,
  promptIdFor,
  sessionStatusForProvider,
  type HostBridgeRuntimeEvent,
  type HostBridgeRuntimeShape,
  type HostBridgeSession,
} from "./HostBridgeRuntime.ts";

const SESSION_EVENT_TYPES = new Set([
  "thread.created",
  "thread.session-set",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.session-stop-requested",
  "thread.meta-updated",
  "thread.unarchived",
  "thread.activity-appended",
  "thread.message-sent",
]);
const CLOSE_EVENT_TYPES = new Set(["thread.deleted", "thread.archived"]);

const toRuntimeError = (detail: string) => (cause: unknown) =>
  new HostBridgeRuntimeError({ detail, cause });

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projects = yield* ProjectionProjectRepository;
  const threads = yield* ProjectionThreadRepository;
  const threadSessions = yield* ProjectionThreadSessionRepository;
  // Optional: the checkpoint projection is not part of the core runtime layer everywhere.
  const checkpoints = yield* Effect.serviceOption(ProjectionCheckpointRepository);
  const approvals = yield* ProjectionPendingApprovalRepository;
  const providers = yield* ProviderInstanceRegistry;
  const crypto = yield* Crypto.Crypto;
  const emittedPrompts = new Set<string>();

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`ditto-host:${tag}:${uuid}`)),
      Effect.orDie,
    );
  const messageId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => MessageId.make(uuid)),
    Effect.orDie,
  );
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const commandsForHarness = (harness: HostBridgeSession["harness"]) =>
    Effect.gen(function* () {
      const instances = yield* providers.listInstances;
      const instance = instances.find(
        (candidate) => candidate.enabled && harnessForProvider(candidate.driverKind) === harness,
      );
      if (instance === undefined) return [];
      const snapshot = yield* instance.snapshot.getSnapshot;
      return commandsFromProviderSnapshot(snapshot);
    }).pipe(Effect.orElseSucceed(() => []));

  const sessionForThread = (thread: ProjectionThread, workspaceRoot: string | null) =>
    Effect.gen(function* () {
      const session = yield* threadSessions.getByThreadId({ threadId: thread.threadId });
      const providerName = Option.isSome(session) ? session.value.providerName : null;
      const harness = harnessForProvider(providerName);
      if (harness === null) return null;
      const cwd = thread.worktreePath ?? workspaceRoot;
      if (cwd === null) return null;
      const status = Option.isSome(session)
        ? sessionStatusForProvider(session.value.status, session.value.activeTurnId)
        : "idle";
      return {
        sessionId: thread.threadId,
        harness,
        cwd,
        mode: "headless",
        status,
        title: thread.title,
        commands: yield* commandsForHarness(harness),
      } satisfies HostBridgeSession;
    });

  const workspaceRootFor = (projectId: ProjectionThread["projectId"]) =>
    projects.getById({ projectId }).pipe(
      Effect.map((project) => (Option.isSome(project) ? project.value.workspaceRoot : null)),
      Effect.orElseSucceed(() => null),
    );

  const listSessions: HostBridgeRuntimeShape["listSessions"] = Effect.gen(function* () {
    const sessions: HostBridgeSession[] = [];
    for (const project of yield* projects.listAll()) {
      const rows = yield* threads.listByProjectId({ projectId: project.projectId });
      for (const thread of rows) {
        if (thread.archivedAt !== null) continue;
        const session = yield* sessionForThread(thread, project.workspaceRoot);
        if (session !== null) sessions.push(session);
      }
    }
    return sessions as ReadonlyArray<HostBridgeSession>;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("host bridge could not list sessions", { cause: Cause.pretty(cause) }).pipe(
        Effect.as([] as ReadonlyArray<HostBridgeSession>),
      ),
    ),
  );

  const pendingPromptsFor = (threadId: ThreadId) =>
    approvals.listByThreadId({ threadId }).pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => row.status === "pending")
          .map((row) => promptIdFor({ kind: "approval", requestId: row.requestId }))
          .filter((promptId) => !emittedPrompts.has(promptId))
          .map((promptId): HostBridgeRuntimeEvent => {
            emittedPrompts.add(promptId);
            return {
              type: "prompt.pending",
              prompt: {
                promptId,
                sessionId: threadId,
                kind: "permission",
                text: "The agent is asking for permission to run a tool.",
                options: PERMISSION_PROMPT_OPTIONS,
                default: "accept",
              },
            };
          }),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<HostBridgeRuntimeEvent>),
    );

  const eventsForThread = (type: string, threadId: ThreadId) =>
    Effect.gen(function* () {
      if (CLOSE_EVENT_TYPES.has(type)) {
        return [{ type: "session.closed", sessionId: threadId }] satisfies HostBridgeRuntimeEvent[];
      }
      if (!SESSION_EVENT_TYPES.has(type)) return [];
      const thread = yield* threads.getById({ threadId });
      if (Option.isNone(thread) || thread.value.archivedAt !== null) {
        return [{ type: "session.closed", sessionId: threadId }] satisfies HostBridgeRuntimeEvent[];
      }
      const session = yield* sessionForThread(
        thread.value,
        yield* workspaceRootFor(thread.value.projectId),
      );
      const out: HostBridgeRuntimeEvent[] =
        session === null ? [] : [{ type: "session.upserted", session }];
      if (type === "thread.activity-appended" && thread.value.pendingApprovalCount > 0) {
        out.push(...(yield* pendingPromptsFor(threadId)));
      }
      return out;
    }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<HostBridgeRuntimeEvent>));

  const events: HostBridgeRuntimeShape["events"] = engine.streamDomainEvents.pipe(
    Stream.mapEffect((event) => {
      const threadId = eventThreadId(event);
      return threadId === null ? Effect.succeed([]) : eventsForThread(event.type, threadId);
    }),
    Stream.flatMap((batch) => Stream.fromIterable(batch)),
  );

  const startTurn = (input: {
    readonly sessionId: string;
    readonly text: string;
    readonly tag: string;
  }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(input.sessionId);
      const thread = yield* threads
        .getById({ threadId })
        .pipe(Effect.mapError(toRuntimeError("Failed to load the session.")));
      if (Option.isNone(thread)) {
        return yield* new HostBridgeRuntimeError({ detail: `Unknown session ${input.sessionId}.` });
      }
      yield* Effect.mapError(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId(input.tag),
          threadId,
          message: {
            messageId: yield* messageId,
            role: "user",
            text: input.text,
            attachments: [],
          },
          modelSelection: thread.value.modelSelection,
          runtimeMode: thread.value.runtimeMode,
          interactionMode: thread.value.interactionMode,
          createdAt: yield* nowIso,
        }),
        toRuntimeError("Failed to start the turn."),
      );
    });

  const submitTurn: HostBridgeRuntimeShape["submitTurn"] = (input) =>
    startTurn({ sessionId: input.sessionId, text: input.text, tag: `turn:${input.turnId}` });

  const submitCommand: HostBridgeRuntimeShape["submitCommand"] = (input) =>
    startTurn({
      sessionId: input.sessionId,
      text: input.args.length > 0 ? `/${input.name} ${input.args}` : `/${input.name}`,
      tag: `command:${input.turnId}`,
    }).pipe(Effect.as({}));

  const answerPrompt: HostBridgeRuntimeShape["answerPrompt"] = (input) =>
    Effect.gen(function* () {
      const target = parsePromptId(input.promptId);
      if (target === null) {
        return yield* new HostBridgeRuntimeError({ detail: `Unknown prompt ${input.promptId}.` });
      }
      const approval = yield* approvals
        .getByRequestId({ requestId: target.requestId as never })
        .pipe(Effect.mapError(toRuntimeError("Failed to look up the prompt.")));
      const threadId =
        input.sessionId !== null
          ? ThreadId.make(input.sessionId)
          : Option.isSome(approval)
            ? approval.value.threadId
            : null;
      if (threadId === null) {
        return yield* new HostBridgeRuntimeError({
          detail: `Prompt ${input.promptId} has no session.`,
        });
      }
      const createdAt = yield* nowIso;
      const dispatched =
        target.kind === "approval"
          ? engine.dispatch({
              type: "thread.approval.respond",
              commandId: yield* commandId(`answer:${target.requestId}`),
              threadId,
              requestId: target.requestId as never,
              decision: approvalDecisionForAnswer(input.value),
              createdAt,
            })
          : engine.dispatch({
              type: "thread.user-input.respond",
              commandId: yield* commandId(`answer:${target.requestId}`),
              threadId,
              requestId: target.requestId as never,
              answers: { answer: input.value },
              createdAt,
            });
      yield* dispatched.pipe(Effect.mapError(toRuntimeError("Failed to answer the prompt.")));
      emittedPrompts.delete(input.promptId);
    });

  const interruptTurn: HostBridgeRuntimeShape["interruptTurn"] = (input) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: yield* commandId(`interrupt:${input.turnId}`),
        threadId: ThreadId.make(input.sessionId),
        createdAt: yield* nowIso,
      });
    }).pipe(Effect.mapError(toRuntimeError("Failed to interrupt the turn.")));

  const createCheckpoint: HostBridgeRuntimeShape["createCheckpoint"] = (input) =>
    (Option.isNone(checkpoints)
      ? Effect.fail(
          new HostBridgeRuntimeError({ detail: "Checkpoints are not available on this server." }),
        )
      : checkpoints.value.listByThreadId({ threadId: ThreadId.make(input.sessionId) })
    ).pipe(
      Effect.mapError(toRuntimeError("Failed to read checkpoints.")),
      Effect.flatMap((rows) => {
        const latest = rows.toSorted((a, b) => b.checkpointTurnCount - a.checkpointTurnCount)[0];
        return latest === undefined
          ? Effect.fail(
              new HostBridgeRuntimeError({
                detail:
                  "No checkpoint exists for this session yet; Teleport push is not wired on this branch.",
              }),
            )
          : Effect.succeed({ generation: String(latest.checkpointRef) });
      }),
    );

  return {
    listSessions,
    events,
    submitTurn,
    submitCommand,
    answerPrompt,
    interruptTurn,
    createCheckpoint,
  } satisfies HostBridgeRuntimeShape;
});

export const layer = Layer.effect(HostBridgeRuntime, make);
