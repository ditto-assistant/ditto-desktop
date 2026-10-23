import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { promptIdFor } from "./HostBridgeRuntime.ts";
import * as HostBridgeRuntime from "./HostBridgeRuntime.ts";
import * as OrchestrationHostBridgeRuntime from "./OrchestrationHostBridgeRuntime.ts";

const THREAD_ID = "thread-1";
const PROJECT_ID = "project-1";

const threadShell = (pendingId: string) =>
  ({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Host thread",
    providerInstanceId: "claudeAgent",
    status: "running",
    activeRunId: "run-1",
    worktreePath: "/work/tree",
    lineage: { relationshipToParent: null },
    creationSource: "web",
    archivedAt: null,
    deletedAt: null,
    // The shell carries a single pending request, whichever one is current.
    pendingRuntimeRequest: { id: pendingId },
  }) as never;

const runtimeRequestUpdated = (requestId: string) =>
  ({
    type: "runtime-request.updated",
    threadId: THREAD_ID,
    payload: { id: requestId, kind: "command", status: "pending" },
  }) as unknown as OrchestrationV2DomainEvent;

it.effect("answers each pending approval on a thread, not only the one the shell shows", () =>
  Effect.gen(function* () {
    const dispatched: Array<{ threadId: string; requestId: string }> = [];
    const layer = OrchestrationHostBridgeRuntime.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            streamDomainEvents: Stream.make(
              runtimeRequestUpdated("request-a"),
              runtimeRequestUpdated("request-b"),
            ),
            getThreadShell: () => Effect.succeed(threadShell("request-b")),
            getShellSnapshot: () =>
              Effect.succeed({ threads: [threadShell("request-b")] } as never),
            dispatch: ((command: { threadId: string; requestId: string }) =>
              Effect.sync(() => {
                dispatched.push({ threadId: command.threadId, requestId: command.requestId });
                return {} as never;
              })) as never,
          }),
          Layer.mock(ProjectService.ProjectService)({
            snapshot: Effect.succeed({ projects: [] } as never),
            getById: () => Effect.succeedSome({ workspaceRoot: "/work" } as never),
          }),
          Layer.mock(ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(undefined),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runtime = yield* HostBridgeRuntime.HostBridgeRuntime;
      const events = yield* runtime.events.pipe(Stream.take(4), Stream.runCollect);
      const prompts = Array.from(events).flatMap((event) =>
        event.type === "prompt.pending" ? [event.prompt.promptId] : [],
      );
      assert.deepEqual(prompts, [
        promptIdFor({ kind: "approval", requestId: "request-a" }),
        promptIdFor({ kind: "approval", requestId: "request-b" }),
      ]);

      // `prompt.answer` frames carry no session id. request-a is not the request the
      // shell shows, so only the owner recorded when it was announced can route it.
      for (const promptId of prompts) {
        yield* runtime.answerPrompt({ sessionId: null, promptId, value: "accept" });
      }
      assert.deepEqual(dispatched, [
        { threadId: THREAD_ID, requestId: "request-a" },
        { threadId: THREAD_ID, requestId: "request-b" },
      ]);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);
