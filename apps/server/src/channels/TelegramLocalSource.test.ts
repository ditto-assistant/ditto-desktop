import { ChannelConversationId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ChannelCommandInput, ChannelCommandOutput } from "./ChannelAdapter.ts";
import { makeTelegramLocalSource } from "./TelegramLocalSource.ts";

function runner(
  respond: (payload: Record<string, unknown>) => unknown,
  calls: Array<Record<string, unknown>>,
) {
  return (input: ChannelCommandInput): Effect.Effect<ChannelCommandOutput, never> => {
    const encoded = input.args[0] ?? "";
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    calls.push(payload);
    return Effect.succeed({ stdout: JSON.stringify(respond(payload)), stderr: "", code: 0 });
  };
}

const status = {
  available: true,
  installed: true,
  permission: "granted",
  client: "telegram-desktop",
  detail: "ready",
} as const;

describe("Telegram local source", () => {
  it.effect("discovers the bundled helper without a Ditto account", () =>
    Effect.gen(function* () {
      const calls: Array<Record<string, unknown>> = [];
      const source = makeTelegramLocalSource({
        platform: "darwin",
        helperPath: "/helper",
        run: runner(() => status, calls),
        nowIso: () => "2026-08-29T00:00:00.000Z",
      });
      const account = yield* source.discover;
      expect(account.state).toBe("ready");
      expect(account.executionLocation).toBe("device");
      expect(account.identityMode).toBe("user");
      expect(calls).toEqual([{ command: "status", prompt: false }]);
    }),
  );

  it.effect("prompts for Accessibility only after the user enables Telegram", () =>
    Effect.gen(function* () {
      const calls: Array<Record<string, unknown>> = [];
      const source = makeTelegramLocalSource({
        platform: "darwin",
        helperPath: "/helper",
        run: runner(() => status, calls),
      });
      const configure = source.configure;
      if (configure === undefined) return yield* Effect.die("missing configure");
      yield* configure(true);
      expect(calls).toEqual([{ command: "status", prompt: true }]);
    }),
  );

  it.effect("keeps native Telegram read-only when it cannot verify destinations", () =>
    Effect.gen(function* () {
      const source = makeTelegramLocalSource({
        platform: "darwin",
        helperPath: "/helper",
        run: runner(
          () => ({
            ...status,
            available: false,
            client: "telegram-macos",
            detail: "Accessibility metadata unavailable",
          }),
          [],
        ),
      });
      const account = yield* source.discover;
      expect(account.state).toBe("setup_required");
      expect(
        account.capabilities.find((capability) => capability.operation === "message.send")
          ?.availability,
      ).toBe("unsupported");
    }),
  );

  it.effect("passes only a public-username conversation to the explicit helper send", () =>
    Effect.gen(function* () {
      const calls: Array<Record<string, unknown>> = [];
      const conversation = {
        accountId: "telegram:desktop:local",
        conversationId: "username:alice",
        service: "telegram",
        title: "Alice",
        kind: "direct",
        participants: [],
        completeness: "device_cache_partial",
      };
      const source = makeTelegramLocalSource({
        platform: "darwin",
        helperPath: "/helper",
        run: runner((payload) => {
          if (payload.command === "snapshot") {
            return { ...status, conversations: [conversation], messages: {} };
          }
          return {
            sent: true,
            detail: "sent",
            message: {
              accountId: "telegram:desktop:local",
              conversationId: "username:alice",
              messageId: "local:send-once",
              service: "telegram",
              sender: { id: "self", displayName: "You", isSelf: true },
              text: "hello",
              sentAt: "2026-08-29T00:00:00.000Z",
              attachments: [],
            },
          };
        }, calls),
      });
      yield* source.listConversations;
      const result = yield* source.sendMessage({
        accountId: "telegram:desktop:local" as never,
        conversationId: ChannelConversationId.make("username:alice"),
        text: "hello",
        idempotencyKey: "send-once",
      });
      expect(result.message.text).toBe("hello");
      expect(calls[1]).toMatchObject({
        command: "send",
        conversationId: "username:alice",
        conversationTitle: "Alice",
      });
    }),
  );
});
