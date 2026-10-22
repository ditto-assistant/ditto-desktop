/**
 * `HostBridgeRuntime` on top of t3code's orchestration v2: every non-archived
 * Claude Code / Codex thread is a session; turns go through
 * `ThreadManagementService.sendToThread`, interrupts through `interruptThread`,
 * and prompt answers are `runtime-request.respond` commands. Prompts come from
 * `runtime-request.updated` domain events; checkpoints resolve to the thread's
 * latest ready checkpoint ref until the Teleport service (feat/teleport) lands.
 *
 * @module remote/OrchestrationHostBridgeRuntime
 */
import {
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
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

/** Domain events after which a thread's announced session may have changed. */
const SESSION_EVENT_TYPES: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.created",
  "thread.unarchived",
  "thread.metadata-updated",
  "thread.model-selection-updated",
  "thread.provider-switched",
  "run.created",
  "run.updated",
  "runtime-request.updated",
  "provider-session.attached",
  "provider-session.updated",
  "provider-session.detached",
]);
const CLOSE_EVENT_TYPES: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.deleted",
  "thread.archived",
]);

/** Runtime requests a permission prompt can answer with an approval decision. */
const APPROVAL_REQUEST_KINDS: ReadonlySet<OrchestrationV2RuntimeRequest["kind"]> = new Set([
  "command",
  "file-read",
  "file-change",
  "permission",
]);

/** A remote Ditto user typing into a host session is a user message from a client. */
const HOST_BRIDGE_PROVENANCE = { createdBy: "user", creationSource: "mobile" } as const;

const toRuntimeError = (detail: string) => (cause: unknown) =>
  new HostBridgeRuntimeError({ detail, cause });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderInstanceRegistry;
  const crypto = yield* Crypto.Crypto;
  // Prompt id -> owning thread. `prompt.answer` frames carry no session id, and
  // a thread's shell shows only one pending request, so the owner recorded when
  // the prompt was announced is what lets several requests on one thread (parallel
  // tool calls) each be answered.
  const emittedPrompts = new Map<string, ThreadId>();

  const commandId = (tag: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => CommandId.make(`ditto-host:${tag}:${uuid}`)),
      Effect.orDie,
    );
  const messageId = crypto.randomUUIDv4().pipe(
    Effect.map((uuid) => MessageId.make(uuid)),
    Effect.orDie,
  );

  const isAnnounceable = (thread: OrchestrationV2ThreadShell) =>
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    !isProviderNativeSubagentThread(thread);

  const sessionForThread = Effect.fn("OrchestrationHostBridgeRuntime.sessionForThread")(function* (
    thread: OrchestrationV2ThreadShell,
    workspaceRoot: string | null,
  ) {
    const instance = yield* providers.getInstance(thread.providerInstanceId);
    // Default instances are keyed by their driver kind, so the id is a usable
    // fallback when the instance is not live in this build.
    const harness = harnessForProvider(instance?.driverKind ?? thread.providerInstanceId);
    if (harness === null) return null;
    const cwd = thread.worktreePath ?? workspaceRoot;
    if (cwd === null) return null;
    const commands =
      instance === undefined || !instance.enabled
        ? []
        : yield* instance.snapshot.getSnapshot.pipe(
            Effect.map(commandsFromProviderSnapshot),
            Effect.orElseSucceed(() => []),
          );
    return {
      sessionId: thread.id,
      harness,
      cwd,
      mode: "headless",
      status: sessionStatusForProvider(thread.status, thread.activeRunId),
      title: thread.title,
      commands,
    } satisfies HostBridgeSession;
  });

  const workspaceRootFor = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.map((project) => (Option.isSome(project) ? project.value.workspaceRoot : null)),
      Effect.orElseSucceed(() => null),
    );

  const listSessions: HostBridgeRuntimeShape["listSessions"] = Effect.gen(function* () {
    const [projectSnapshot, shellSnapshot] = yield* Effect.all([
      projects.snapshot,
      threads.getShellSnapshot(),
    ]);
    const roots = new Map(
      projectSnapshot.projects.map((project) => [project.id, project.workspaceRoot] as const),
    );
    const sessions: HostBridgeSession[] = [];
    for (const thread of shellSnapshot.threads) {
      if (!isAnnounceable(thread)) continue;
      const session = yield* sessionForThread(thread, roots.get(thread.projectId) ?? null);
      if (session !== null) sessions.push(session);
    }
    return sessions as ReadonlyArray<HostBridgeSession>;
  }).pipe(
    Effect.withSpan("OrchestrationHostBridgeRuntime.listSessions"),
    Effect.catchCause((cause) =>
      Effect.logWarning("host bridge could not list sessions", { cause: Cause.pretty(cause) }).pipe(
        Effect.as([] as ReadonlyArray<HostBridgeSession>),
      ),
    ),
  );

  const promptForRequest = (
    threadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
  ): ReadonlyArray<HostBridgeRuntimeEvent> => {
    const promptId = promptIdFor({ kind: "approval", requestId: request.id });
    if (request.status !== "pending") {
      emittedPrompts.delete(promptId);
      return [];
    }
    // DITTO: user_input / mcp-elicitation requests carry per-question ids
    // that the host bridge protocol cannot express yet, so only approvals are
    // surfaced as prompts.
    if (!APPROVAL_REQUEST_KINDS.has(request.kind) || emittedPrompts.has(promptId)) return [];
    emittedPrompts.set(promptId, threadId);
    return [
      {
        type: "prompt.pending",
        prompt: {
          promptId,
          sessionId: threadId,
          kind: "permission",
          text: "The agent is asking for permission to run a tool.",
          options: PERMISSION_PROMPT_OPTIONS,
          default: "accept",
        },
      },
    ];
  };

  const eventsFor = Effect.fn("OrchestrationHostBridgeRuntime.eventsFor")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    const threadId = event.threadId;
    const closed: ReadonlyArray<HostBridgeRuntimeEvent> = [
      { type: "session.closed", sessionId: threadId },
    ];
    if (CLOSE_EVENT_TYPES.has(event.type)) return closed;
    if (!SESSION_EVENT_TYPES.has(event.type)) return [];
    // Projections commit with the event, so the shell already reflects it.
    const thread = yield* threads.getThreadShell(threadId);
    if (thread === null || thread.archivedAt !== null || thread.deletedAt !== null) return closed;
    if (isProviderNativeSubagentThread(thread)) return [];
    const session = yield* sessionForThread(thread, yield* workspaceRootFor(thread.projectId));
    if (session === null) return [];
    const out: HostBridgeRuntimeEvent[] = [{ type: "session.upserted", session }];
    if (event.type === "runtime-request.updated") {
      out.push(...promptForRequest(threadId, event.payload));
    }
    return out;
  });

  // Each host connection subscribes afresh. A failed subscription is retried
  // after a pause so one store error does not silence the connection.
  const domainEvents = (): Stream.Stream<OrchestrationV2DomainEvent> =>
    threads.streamDomainEvents.pipe(
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Stream.empty
          : Stream.fromEffect(
              Effect.logWarning("host bridge domain event stream failed; resubscribing", {
                cause: Cause.pretty(cause),
              }).pipe(Effect.andThen(Effect.sleep("1 second"))),
            ).pipe(Stream.flatMap(() => domainEvents())),
      ),
    );

  const events: HostBridgeRuntimeShape["events"] = domainEvents().pipe(
    Stream.mapEffect((event) =>
      eventsFor(event).pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<HostBridgeRuntimeEvent>),
      ),
    ),
    Stream.flatMap((batch) => Stream.fromIterable(batch)),
  );

  const loadThread = Effect.fn("OrchestrationHostBridgeRuntime.loadThread")(function* (
    sessionId: string,
  ) {
    const thread = yield* threads
      .getThreadShell(ThreadId.make(sessionId))
      .pipe(Effect.mapError(toRuntimeError("Failed to load the session.")));
    if (thread === null || thread.deletedAt !== null) {
      return yield* new HostBridgeRuntimeError({ detail: `Unknown session ${sessionId}.` });
    }
    return thread;
  });

  const startTurn = Effect.fn("OrchestrationHostBridgeRuntime.startTurn")(function* (input: {
    readonly sessionId: string;
    readonly text: string;
    readonly tag: string;
  }) {
    const thread = yield* loadThread(input.sessionId);
    yield* threads
      .sendToThread({
        projectId: thread.projectId,
        commandId: yield* commandId(input.tag),
        threadId: thread.id,
        messageId: yield* messageId,
        text: input.text,
        attachments: [],
        // Starts when idle and queues behind an active run, as the v1 turn start did.
        mode: "auto",
        ...HOST_BRIDGE_PROVENANCE,
      })
      .pipe(Effect.mapError(toRuntimeError("Failed to start the turn.")));
  });

  const submitTurn: HostBridgeRuntimeShape["submitTurn"] = (input) =>
    startTurn({ sessionId: input.sessionId, text: input.text, tag: `turn:${input.turnId}` });

  const submitCommand: HostBridgeRuntimeShape["submitCommand"] = (input) =>
    startTurn({
      sessionId: input.sessionId,
      text: input.args.length > 0 ? `/${input.name} ${input.args}` : `/${input.name}`,
      tag: `command:${input.turnId}`,
    }).pipe(Effect.as({}));

  /** Without a session id, the thread whose shell shows this request pending owns it. */
  const threadForRequest = (requestId: RuntimeRequestId) =>
    threads.getShellSnapshot().pipe(
      Effect.map(
        (snapshot) =>
          snapshot.threads.find((thread) => thread.pendingRuntimeRequest?.id === requestId)?.id ??
          null,
      ),
      Effect.mapError(toRuntimeError("Failed to look up the prompt.")),
    );

  const answerPrompt: HostBridgeRuntimeShape["answerPrompt"] = Effect.fn(
    "OrchestrationHostBridgeRuntime.answerPrompt",
  )(function* (input: Parameters<HostBridgeRuntimeShape["answerPrompt"]>[0]) {
    const target = parsePromptId(input.promptId);
    if (target === null) {
      return yield* new HostBridgeRuntimeError({ detail: `Unknown prompt ${input.promptId}.` });
    }
    const requestId = RuntimeRequestId.make(target.requestId);
    const threadId =
      input.sessionId !== null
        ? ThreadId.make(input.sessionId)
        : (emittedPrompts.get(input.promptId) ?? (yield* threadForRequest(requestId)));
    if (threadId === null) {
      return yield* new HostBridgeRuntimeError({
        detail: `Prompt ${input.promptId} has no session.`,
      });
    }
    yield* threads
      .dispatch({
        type: "runtime-request.respond",
        commandId: yield* commandId(`answer:${target.requestId}`),
        threadId,
        requestId,
        ...(target.kind === "approval"
          ? { decision: approvalDecisionForAnswer(input.value) }
          : // DITTO: a fixed key, because question prompts are not surfaced yet
            // (see promptForRequest) so there is no question id to key by.
            { answers: { answer: input.value } }),
      })
      .pipe(Effect.mapError(toRuntimeError("Failed to answer the prompt.")));
    emittedPrompts.delete(input.promptId);
  });

  const interruptTurn: HostBridgeRuntimeShape["interruptTurn"] = Effect.fn(
    "OrchestrationHostBridgeRuntime.interruptTurn",
  )(function* (input: Parameters<HostBridgeRuntimeShape["interruptTurn"]>[0]) {
    const thread = yield* loadThread(input.sessionId);
    // `no_active_run` and `already_terminal` both mean there is nothing left to stop.
    yield* threads
      .interruptThread({
        projectId: thread.projectId,
        commandId: yield* commandId(`interrupt:${input.turnId}`),
        threadId: thread.id,
      })
      .pipe(Effect.mapError(toRuntimeError("Failed to interrupt the turn.")));
  });

  const createCheckpoint: HostBridgeRuntimeShape["createCheckpoint"] = Effect.fn(
    "OrchestrationHostBridgeRuntime.createCheckpoint",
  )(function* (input: Parameters<HostBridgeRuntimeShape["createCheckpoint"]>[0]) {
    const records = yield* threads
      .getThreadRecords(ThreadId.make(input.sessionId), ["checkpoints"])
      .pipe(Effect.mapError(toRuntimeError("Failed to read checkpoints.")));
    const latest = records.checkpoints
      .filter((checkpoint) => checkpoint.status === "ready")
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.capturedAt) - DateTime.toEpochMillis(left.capturedAt),
      )[0];
    if (latest === undefined) {
      return yield* new HostBridgeRuntimeError({
        detail:
          "No checkpoint exists for this session yet; Teleport push is not wired on this branch.",
      });
    }
    return { generation: String(latest.ref) };
  });

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
