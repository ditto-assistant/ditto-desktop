import {
  ChannelAccountId,
  ChannelConversationId,
  ChannelMessageId,
  type ConnectedChannelAccount,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeTelegramAdapter, type TelegramChannelSource } from "./TelegramAdapter.ts";

const account: ConnectedChannelAccount = {
  accountId: ChannelAccountId.make("telegram:desktop:local"),
  service: "telegram",
  transport: "telegram-desktop-local",
  executionLocation: "device",
  identityMode: "user",
  label: "Telegram on this Mac",
  enabled: true,
  state: "ready",
  capabilities: [],
  completeness: "device_cache_partial",
};

function source(label: string): TelegramChannelSource {
  return {
    discover: Effect.succeed({ ...account, label }),
    listConversations: Effect.succeed([]),
    listMessages: () => Effect.succeed([]),
    sendMessage: (input) =>
      Effect.succeed({
        transport: "telegram-desktop-local",
        message: {
          accountId: input.accountId,
          conversationId: input.conversationId,
          messageId: ChannelMessageId.make(input.idempotencyKey),
          service: "telegram",
          sender: { id: "self", displayName: "You", isSelf: true },
          text: input.text,
          sentAt: "2026-08-29T00:00:00.000Z",
          attachments: [],
        },
      }),
  };
}

describe("Telegram adapter", () => {
  it.effect("selects the source at operation time so cloud can replace local after sign in", () =>
    Effect.gen(function* () {
      let active = source("Local");
      const adapter = makeTelegramAdapter(() => ({ mode: "local", source: active }));
      expect((yield* adapter.discover).label).toBe("Local");
      active = source("Ditto Cloud");
      expect((yield* adapter.discover).label).toBe("Ditto Cloud");
    }),
  );

  it.effect("delegates an explicit send without changing the stable inbox account id", () =>
    Effect.gen(function* () {
      const adapter = makeTelegramAdapter(() => ({ mode: "local", source: source("Local") }));
      const result = yield* adapter.sendMessage({
        accountId: account.accountId,
        conversationId: ChannelConversationId.make("username:telegram"),
        text: "hello",
        idempotencyKey: "send-once",
      });
      expect(result.message.text).toBe("hello");
      expect(result.transport).toBe("telegram-desktop-local");
    }),
  );
});
