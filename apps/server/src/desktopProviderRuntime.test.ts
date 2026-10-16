import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderRuntimeEvent, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DesktopProviderStart, runDesktopProviderTurn } from "./desktopProviderRuntime.ts";
import type { ProviderAdapterShape } from "./provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "./provider/Errors.ts";

const input = Schema.decodeSync(DesktopProviderStart)({
  type: "start",
  provider: "codex",
  binaryPath: "/fixture/codex",
  stateDir: "/fixture/state",
  prompt: "Read the project",
  session: {
    threadId: "desktop-thread",
    cwd: "/fixture/project",
    runtimeMode: "auto-accept-edits",
  },
});

const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

const fixture = Effect.fn(function* (
  events: ReadonlyArray<{ type: string; payload: object; requestId?: string }>,
  options: { approval?: boolean; blocked?: boolean } = {},
) {
  const bus = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const observed: ProviderRuntimeEvent[] = [];
  let stopped = false;
  let interrupted = false;
  let decision: string | undefined;
  const emit = (event: { type: string; payload: object; requestId?: string }) =>
    PubSub.publish(
      bus,
      decodeEvent({
        eventId: `event-${observed.length}`,
        provider: "codex",
        threadId: input.session.threadId,
        createdAt: "2026-10-15T12:00:00.000Z",
        turnId: "turn-1",
        ...event,
      }),
    );
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: ProviderDriverKind.make("codex"),
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (session) =>
      Effect.succeed({
        ...session,
        provider: ProviderDriverKind.make("codex"),
        status: "ready",
        createdAt: "2026-10-15T12:00:00.000Z",
        updatedAt: "2026-10-15T12:00:00.000Z",
      }),
    sendTurn: () =>
      Effect.gen(function* () {
        yield* emit({ type: "turn.started", payload: {} });
        for (const event of events) yield* emit(event);
        return { threadId: input.session.threadId, turnId: TurnId.make("turn-1") };
      }),
    streamEvents: Stream.fromPubSub(bus),
    listSessions: () =>
      Effect.succeed([
        {
          threadId: input.session.threadId,
          provider: ProviderDriverKind.make("codex"),
          status: "ready",
          runtimeMode: "auto-accept-edits",
          resumeCursor: { threadId: "native-thread" },
          createdAt: "2026-10-15T12:00:00.000Z",
          updatedAt: "2026-10-15T12:00:00.000Z",
        },
      ]),
    respondToRequest: (_thread, _request, value) =>
      Effect.gen(function* () {
        decision = value;
        if (options.approval)
          yield* emit({ type: "turn.completed", payload: { state: "completed" } });
      }),
    interruptTurn: () =>
      Effect.sync(() => {
        interrupted = true;
      }),
    stopAll: () =>
      Effect.sync(() => {
        stopped = true;
      }),
    stopSession: () => Effect.void,
    hasSession: () => Effect.succeed(true),
    respondToUserInput: () => Effect.void,
    readThread: () => Effect.succeed({ threadId: ThreadId.make("desktop-thread"), turns: [] }),
    rollbackThread: () => Effect.succeed({ threadId: ThreadId.make("desktop-thread"), turns: [] }),
  };
  const run = runDesktopProviderTurn(adapter, input, {
    event: (event) => observed.push(event),
    approve: () => Effect.succeed("decline"),
  }).pipe(Effect.scoped);
  return {
    run,
    observed,
    stopped: () => stopped,
    interrupted: () => interrupted,
    decision: () => decision,
  };
});

it.effect(
  "subscribes before an immediate turn and preserves structured traces without mixing reasoning into text",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture([
        {
          type: "content.delta",
          payload: { streamKind: "reasoning_text", delta: "Private reasoning" },
        },
        { type: "item.started", payload: { itemType: "command_execution", title: "Read project" } },
        { type: "content.delta", payload: { streamKind: "assistant_text", delta: "Ditto ✓ café" } },
        { type: "turn.completed", payload: { state: "completed" } },
      ]);
      const result = yield* f.run;
      assert.strictEqual(result.text, "Ditto ✓ café");
      assert.deepStrictEqual(result.resumeCursor, { threadId: "native-thread" });
      assert.strictEqual(f.observed.length, 5);
      assert.isTrue(f.stopped());
    }),
);

it.effect(
  "routes permission decisions to the adapter without granting session-wide permission",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        [
          {
            type: "request.opened",
            requestId: "permission-1",
            payload: { requestType: "command_execution_approval" },
          },
        ],
        { approval: true },
      );
      yield* f.run;
      assert.strictEqual(f.decision(), "decline");
      assert.isTrue(f.stopped());
    }),
);

for (const event of [
  { type: "turn.completed", payload: { state: "failed", errorMessage: "Authentication expired" } },
  { type: "session.exited", payload: { reason: "Agent disconnected" } },
]) {
  it.effect(`fails on ${event.type} and releases the provider`, () =>
    Effect.gen(function* () {
      const f = yield* fixture([event]);
      const result = yield* Effect.exit(f.run);
      assert.strictEqual(result._tag, "Failure");
      assert.isTrue(f.stopped());
      assert.isTrue(f.interrupted());
    }),
  );
}

it.effect("preserves partial text when the adapter reports cancellation", () =>
  Effect.gen(function* () {
    const f = yield* fixture([
      { type: "content.delta", payload: { streamKind: "assistant_text", delta: "Partial answer" } },
      { type: "turn.aborted", payload: { reason: "User stopped the task" } },
    ]);
    const result = yield* f.run;
    assert.isTrue(result.cancelled);
    assert.strictEqual(result.text, "Partial answer");
  }),
);

it.effect(
  "a structured question ends a still-pending native prompt and releases its provider",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(
        [{ type: "user-input.requested", requestId: "question-1", payload: { questions: [] } }],
        { blocked: true },
      );
      const result = yield* Effect.exit(f.run);
      assert.strictEqual(result._tag, "Failure");
      assert.isTrue(f.stopped());
    }),
);
