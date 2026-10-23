import { assert, it } from "@effect/vitest";
import {
  DittoHarnessError,
  DittoSettings,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type {
  DittoHarnessOpener,
  DittoRuntimeSettings,
  NativeHarness,
  OpenHarness,
} from "../dittoHarness/DittoHarnessRuntime.ts";
import { makeDittoAdapter } from "./DittoAdapter.ts";

const settings = Schema.decodeSync(DittoSettings)({});
const instanceId = ProviderInstanceId.make("ditto");
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
} satisfies ProviderAdapter.ProviderAdapterV2RuntimePolicy;

const harness = (chat: NativeHarness["chat"]): NativeHarness => ({
  seedUser: async () => undefined,
  saveMemory: async () => ({}),
  searchMemories: async () => [],
  searchSubjects: async () => [],
  dream: async () => ({}),
  chat,
});

const opener =
  (nativeHarness: NativeHarness): DittoHarnessOpener =>
  <Settings extends DittoRuntimeSettings>(
    runtimeSettings: Settings,
  ): Effect.Effect<OpenHarness<Settings>, DittoHarnessError> =>
    Effect.succeed({
      key: "test",
      databasePath: ":memory:",
      settings: runtimeSettings,
      harness: nativeHarness,
      version: "test",
    });

const failingOpener: DittoHarnessOpener = <Settings extends DittoRuntimeSettings>(
  _runtimeSettings: Settings,
): Effect.Effect<OpenHarness<Settings>, DittoHarnessError> =>
  Effect.fail(
    new DittoHarnessError({
      kind: "unavailable",
      message: "open failed",
    }),
  );

// Opens a session, starts one turn, and returns every event up to its terminal.
const runOneTurn = (open: DittoHarnessOpener, text: string) =>
  Effect.gen(function* () {
    const adapter = yield* makeDittoAdapter(settings, { instanceId, opener: open });
    const threadId = ThreadId.make("ditto-thread");
    const modelSelection = { instanceId, model: settings.chatModel };
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("ditto-session"),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    const eventsFiber = yield* session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* session.startTurn({
      appThread: {} as OrchestrationV2AppThread,
      threadId,
      runId: RunId.make("run-1"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("attempt-1"),
      rootNodeId: NodeId.make("node-1"),
      providerThread,
      message: {
        messageId: MessageId.make("message-1"),
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection,
      runtimePolicy,
    });
    return Array.from(yield* Fiber.join(eventsFiber));
  }).pipe(Effect.scoped);

it.effect("publishes the harness reply and a completed terminal", () =>
  Effect.gen(function* () {
    const events = yield* runOneTurn(
      opener(harness(async () => ({ response: " ok ", cost: 0, toolCalls: [] }))),
      "hello",
    );
    const assistant = events.find(
      (event) => event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
    );
    assert.equal(
      assistant?.type === "turn_item.updated" && assistant.turnItem.type === "assistant_message"
        ? assistant.turnItem.text
        : undefined,
      "ok",
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");
  }),
);

it.effect("fails the turn when opening the harness fails", () =>
  Effect.gen(function* () {
    const events = yield* runOneTurn(failingOpener, "hello");
    const terminal = events.at(-1);
    assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "failed");
  }),
);
