import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DittoHarnessError,
  DittoSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
  DittoHarnessOpener,
  DittoRuntimeSettings,
  NativeHarness,
  OpenHarness,
} from "../../dittoHarness/DittoHarnessRuntime.ts";
import { makeDittoAdapter } from "./DittoAdapter.ts";

const settings = Schema.decodeSync(DittoSettings)({});
const instanceId = ProviderInstanceId.make("ditto");

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

const makeAdapter = (open: DittoHarnessOpener) =>
  makeDittoAdapter(settings, { instanceId, opener: open }).pipe(Effect.provide(NodeServices.layer));

it.effect("keeps turn IDs monotonic after rollback", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(
      opener(
        harness(async () => ({
          response: "ok",
          cost: 0,
          toolCalls: [],
        })),
      ),
    );
    const threadId = ThreadId.make("ditto-rollback");
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("ditto"),
      threadId,
      runtimeMode: "full-access",
    });

    const first = yield* adapter.sendTurn({ threadId, input: "first" });
    yield* adapter.rollbackThread(threadId, 1);
    const second = yield* adapter.sendTurn({ threadId, input: "second" });

    assert.notEqual(first.turnId, second.turnId);
  }),
);

it.effect("finalizes the active turn when opening the harness fails", () =>
  Effect.gen(function* () {
    const adapter = yield* makeAdapter(failingOpener);
    const threadId = ThreadId.make("ditto-open-failure");
    const eventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("ditto"),
      threadId,
      runtimeMode: "full-access",
    });

    const error = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.flip);
    const sessions = yield* adapter.listSessions();
    const events = yield* Fiber.join(eventsFiber);

    assert.equal(error._tag, "ProviderAdapterRequestError");
    assert.equal(sessions[0]?.status, "error");
    assert.equal(sessions[0]?.activeTurnId, undefined);
    assert.isTrue(
      Array.from(events).some(
        (event) => event.type === "turn.completed" && event.payload.state === "failed",
      ),
    );
  }),
);
