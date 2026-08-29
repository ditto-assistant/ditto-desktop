import { ChannelConversationId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  DISCORD_LOCAL_ACCOUNT_ID,
  type DiscordLocalSource,
  makeDiscordLocalAdapter,
} from "./DiscordLocalAdapter.ts";

function makeSource(overrides: Partial<DiscordLocalSource> = {}): DiscordLocalSource {
  return {
    status: async () => ({
      protocolVersion: 1,
      connected: true,
      loginPending: false,
      detail: "Connected.",
      user: { id: "self", displayName: "Peyton", isSelf: true },
    }),
    startLogin: async () => ({
      qrUrl: "https://discordapp.com/ra/fingerprint",
      expiresInSeconds: 180,
    }),
    logout: async () => undefined,
    listConversations: async () => [],
    listMessages: async () => [],
    sendMessage: async (input) => ({
      id: "message-1",
      channelId: input.channelId,
      content: input.content,
      timestamp: "2026-08-29T12:30:00.000Z",
      author: { id: "self", displayName: "Peyton", isSelf: true },
      attachments: [],
      nonce: input.idempotencyKey,
    }),
    ...overrides,
  };
}

it.effect("does not start the Discord sidecar until an adapter operation runs", () =>
  Effect.gen(function* () {
    let calls = 0;
    const adapter = makeDiscordLocalAdapter(
      makeSource({
        status: async () => {
          calls += 1;
          return {
            protocolVersion: 1,
            connected: true,
            loginPending: false,
            detail: "Connected.",
          };
        },
      }),
    );

    expect(calls).toBe(0);
    yield* adapter.discover;
    expect(calls).toBe(1);
    yield* adapter.discover;
    expect(calls).toBe(2);
  }),
);

it.effect("returns the one-time Discord login URL from configure", () =>
  Effect.gen(function* () {
    const adapter = makeDiscordLocalAdapter(makeSource());
    const configure = adapter.configure;
    expect(configure).toBeDefined();
    if (configure === undefined) return;

    const account = yield* configure(true);
    expect(account.state).toBe("syncing");
    expect(account.setupUrl).toBe("https://discordapp.com/ra/fingerprint");
  }),
);

it.effect("normalizes protocol conversations and authoritative send receipts", () =>
  Effect.gen(function* () {
    const adapter = makeDiscordLocalAdapter(
      makeSource({
        listConversations: async () => [
          {
            id: "channel-1",
            title: "Liam",
            kind: "direct",
            latestMessageAt: "2026-08-29T12:00:00.000Z",
            participants: [{ id: "liam", displayName: "Liam" }],
          },
        ],
      }),
    );

    const conversations = yield* adapter.listConversations;
    expect(conversations[0]?.latestMessageAt).toBe("2026-08-29T12:00:00.000Z");

    const result = yield* adapter.sendMessage({
      accountId: DISCORD_LOCAL_ACCOUNT_ID,
      conversationId: ChannelConversationId.make("channel-1"),
      text: "hello",
      idempotencyKey: "action-1",
    });
    expect(result.message.messageId).toBe("message-1");
    expect(result.transport).toBe("discord-local-user");
  }),
);
