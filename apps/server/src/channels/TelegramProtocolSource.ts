import {
  ChannelConversationId,
  ChannelMessageId,
  ChannelOperationError,
  type ChannelCapability,
  type ChannelMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { TELEGRAM_LOCAL_ACCOUNT_ID, type TelegramChannelSource } from "./TelegramAdapter.ts";
import type {
  TelegramSidecarClient,
  TelegramSidecarMessage,
  TelegramSidecarStatus,
} from "./TelegramSidecarClient.ts";

const capabilities: ReadonlyArray<ChannelCapability> = [
  { operation: "history.read", availability: "available" },
  {
    operation: "events.live",
    availability: "setup_required",
    reason:
      "The protocol source is live; push delivery into the inbox event stream is not wired yet.",
  },
  { operation: "message.send", availability: "available" },
  { operation: "message.reply", availability: "unsupported" },
  {
    operation: "attachment.read",
    availability: "unsupported",
    reason: "Telegram media metadata is visible, but local byte download is not wired yet.",
  },
  { operation: "attachment.write", availability: "unsupported" },
  ...(
    [
      "message.edit",
      "message.delete",
      "reaction.read",
      "reaction.write",
      "thread.read",
      "thread.write",
      "mention.write",
      "typing.write",
      "read_state.write",
      "poll.read",
      "poll.write",
      "voice_note.read",
      "voice_note.write",
      "call.read",
      "call.start",
    ] as const
  ).map((operation) => ({ operation, availability: "unsupported" as const })),
];

function operation<A>(run: () => Promise<A>): Effect.Effect<A, ChannelOperationError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ChannelOperationError({
        accountId: TELEGRAM_LOCAL_ACCOUNT_ID,
        kind: String(cause).includes("not connected") ? "setup_required" : "transport_failed",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

function account(status: TelegramSidecarStatus) {
  return {
    accountId: TELEGRAM_LOCAL_ACCOUNT_ID,
    service: "telegram" as const,
    transport: "telegram-desktop-local" as const,
    executionLocation: "device" as const,
    identityMode: "user" as const,
    label: status.user?.displayName ?? "Telegram on this device",
    enabled: status.connected || status.loginPending,
    state: status.connected
      ? ("ready" as const)
      : status.loginPending
        ? ("syncing" as const)
        : ("setup_required" as const),
    capabilities: status.configured
      ? capabilities
      : capabilities.map((value) => ({
          ...value,
          availability: "setup_required" as const,
        })),
    completeness: status.connected ? ("provider_scoped" as const) : ("unknown" as const),
    statusDetail: status.detail,
  };
}

function normalizeMessage(value: TelegramSidecarMessage): ChannelMessage {
  return {
    accountId: TELEGRAM_LOCAL_ACCOUNT_ID,
    conversationId: ChannelConversationId.make(value.channelId),
    messageId: ChannelMessageId.make(value.id),
    service: "telegram",
    sender: value.author,
    text: value.content,
    sentAt: value.timestamp,
    ...(value.replyToId !== undefined
      ? { replyToMessageId: ChannelMessageId.make(value.replyToId) }
      : {}),
    attachments: value.attachments.map((attachment) => ({
      id: attachment.id,
      ...(attachment.filename !== undefined ? { filename: attachment.filename } : {}),
      ...(attachment.size !== undefined ? { byteSize: attachment.size } : {}),
    })),
  };
}

export function makeTelegramProtocolSource(
  client: TelegramSidecarClient,
  archiveFallback: TelegramChannelSource,
): TelegramChannelSource {
  const discover = operation(() => client.restore()).pipe(
    Effect.map(account),
    Effect.catch(() => operation(() => client.status()).pipe(Effect.map(account))),
  );
  return {
    discover,
    configure: (enabled) =>
      enabled
        ? operation(() => client.startLogin()).pipe(
            Effect.map((result) =>
              result.connected
                ? account(result.status)
                : {
                    ...account({
                      protocolVersion: 1,
                      configured: true,
                      connected: false,
                      loginPending: true,
                      detail: "Approve this one-time Telegram sign-in from another device.",
                    }),
                    setupUrl: result.qrUrl,
                  },
            ),
          )
        : operation(() => client.logout()).pipe(Effect.andThen(discover)),
    listConversations: operation(() => client.listConversations()).pipe(
      Effect.map((values) =>
        values.map((value) => ({
          accountId: TELEGRAM_LOCAL_ACCOUNT_ID,
          conversationId: ChannelConversationId.make(value.id),
          service: "telegram" as const,
          title: value.title,
          kind: value.kind,
          participants: [...value.participants],
          ...(value.latestMessageAt !== undefined
            ? { latestMessageAt: value.latestMessageAt }
            : {}),
          completeness: "provider_scoped" as const,
        })),
      ),
      Effect.catch(() => archiveFallback.listConversations),
    ),
    listMessages: (conversationId, limit = 100) =>
      operation(() => client.listMessages(conversationId, limit)).pipe(
        Effect.map((values) => values.map(normalizeMessage)),
        Effect.catch(() => archiveFallback.listMessages(conversationId, limit)),
      ),
    sendMessage: (input) =>
      operation(() =>
        client.sendMessage({
          channelId: input.conversationId,
          content: input.text,
          idempotencyKey: input.idempotencyKey,
        }),
      ).pipe(
        Effect.map((value) => ({
          message: normalizeMessage(value),
          transport: "telegram-desktop-local" as const,
        })),
      ),
  };
}
