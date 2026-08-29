import {
  ChannelAccountId,
  ChannelConversationId,
  ChannelMessageId,
  ChannelOperationError,
  type ChannelConversation,
  type ChannelMessage,
  type ConnectedChannelAccount,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ChannelAdapter } from "./ChannelAdapter.ts";
import { DISCORD_ACCOUNT_ID, makeDiscordCompositeAdapter } from "./DiscordCompositeAdapter.ts";
import { DISCORD_LOCAL_ACCOUNT_ID } from "./DiscordLocalAdapter.ts";

function account(
  id: string,
  transport: "discord-discrawl" | "discord-local-user",
  state: "ready" | "setup_required",
): ConnectedChannelAccount {
  return {
    accountId: ChannelAccountId.make(id),
    service: "discord",
    transport,
    executionLocation: "device",
    identityMode: transport === "discord-discrawl" ? "archive" : "user",
    label: "Discord",
    enabled: true,
    state,
    capabilities: [
      {
        operation: "message.send",
        availability: transport === "discord-local-user" ? "available" : "unsupported",
      },
    ],
    completeness: transport === "discord-discrawl" ? "device_cache_partial" : "provider_scoped",
  };
}

function conversation(accountId: string, title: string): ChannelConversation {
  return {
    accountId: ChannelAccountId.make(accountId),
    conversationId: ChannelConversationId.make("channel-1"),
    service: "discord",
    title,
    kind: "direct",
    participants: [],
    completeness: "provider_scoped",
  };
}

function message(accountId: string, text: string, cachedAttachmentId?: string): ChannelMessage {
  return {
    accountId: ChannelAccountId.make(accountId),
    conversationId: ChannelConversationId.make("channel-1"),
    messageId: ChannelMessageId.make("message-1"),
    service: "discord",
    sender: { id: "liam", displayName: "Liam" },
    text,
    sentAt: "2026-08-29T12:00:00.000Z",
    attachments: [
      {
        id: "attachment-1",
        filename: "image.png",
        ...(cachedAttachmentId !== undefined
          ? { cachedAttachmentId, cacheState: "cached" as const }
          : { remoteUrl: "https://cdn.discordapp.com/image.png" }),
      },
    ],
  };
}

function adapter(input: {
  readonly discovered: ConnectedChannelAccount;
  readonly conversations?: ReadonlyArray<ChannelConversation>;
  readonly messages?: ReadonlyArray<ChannelMessage>;
  readonly failRead?: boolean;
}): ChannelAdapter {
  const failure = new ChannelOperationError({
    accountId: input.discovered.accountId,
    kind: "transport_failed",
    message: "offline",
  });
  return {
    discover: Effect.succeed(input.discovered),
    listConversations: input.failRead
      ? Effect.fail(failure)
      : Effect.succeed(input.conversations ?? []),
    listMessages: () =>
      input.failRead ? Effect.fail(failure) : Effect.succeed(input.messages ?? []),
    sendMessage: (send) =>
      Effect.succeed({
        message: {
          ...message(input.discovered.accountId, send.text),
          messageId: ChannelMessageId.make("receipt-1"),
        },
        transport: input.discovered.transport,
      }),
  };
}

it.effect("uses the live protocol while retaining Discrawl media enrichment", () =>
  Effect.gen(function* () {
    const composite = makeDiscordCompositeAdapter({
      protocol: adapter({
        discovered: account(DISCORD_LOCAL_ACCOUNT_ID, "discord-local-user", "ready"),
        conversations: [conversation(DISCORD_LOCAL_ACCOUNT_ID, "Liam live")],
        messages: [message(DISCORD_LOCAL_ACCOUNT_ID, "latest")],
      }),
      archive: adapter({
        discovered: account(DISCORD_ACCOUNT_ID, "discord-discrawl", "ready"),
        conversations: [conversation(DISCORD_ACCOUNT_ID, "Liam cached")],
        messages: [message(DISCORD_ACCOUNT_ID, "older", "cached-1")],
      }),
    });

    const discovered = yield* composite.discover;
    const conversations = yield* composite.listConversations;
    const messages = yield* composite.listMessages("channel-1", 100);

    expect(discovered.accountId).toBe(DISCORD_ACCOUNT_ID);
    expect(discovered.transport).toBe("discord-local-user");
    expect(conversations[0]?.title).toBe("Liam live");
    expect(messages[0]?.text).toBe("latest");
    expect(messages[0]?.attachments[0]?.cachedAttachmentId).toBe("cached-1");
  }),
);

it.effect("falls back to Discrawl without exposing a second Discord account", () =>
  Effect.gen(function* () {
    const composite = makeDiscordCompositeAdapter({
      protocol: adapter({
        discovered: account(DISCORD_LOCAL_ACCOUNT_ID, "discord-local-user", "setup_required"),
        failRead: true,
      }),
      archive: adapter({
        discovered: account(DISCORD_ACCOUNT_ID, "discord-discrawl", "ready"),
        conversations: [conversation(DISCORD_ACCOUNT_ID, "Liam")],
      }),
    });

    const discovered = yield* composite.discover;
    const conversations = yield* composite.listConversations;
    expect(discovered.accountId).toBe(DISCORD_ACCOUNT_ID);
    expect(discovered.transport).toBe("discord-discrawl");
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.accountId).toBe(DISCORD_ACCOUNT_ID);
  }),
);
