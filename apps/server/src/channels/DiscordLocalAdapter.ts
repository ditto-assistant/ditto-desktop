import {
  ChannelAccountId,
  ChannelConversationId,
  ChannelMessageId,
  ChannelOperationError,
  type ChannelCapability,
  type ChannelMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ChannelAdapter } from "./ChannelAdapter.ts";
import type {
  DiscordSidecarClient,
  DiscordSidecarConversation,
  DiscordSidecarMessage,
  DiscordSidecarStatus,
} from "./DiscordSidecarClient.ts";

export const DISCORD_LOCAL_ACCOUNT_ID = ChannelAccountId.make("discord:protocol:local");

const capabilities: ReadonlyArray<ChannelCapability> = [
  { operation: "history.read", availability: "available" },
  {
    operation: "events.live",
    availability: "setup_required",
    reason:
      "The native transport emits live events; the inbox event subscription lands in the next stack layer.",
  },
  { operation: "message.send", availability: "available" },
  { operation: "message.reply", availability: "available" },
  { operation: "attachment.read", availability: "available" },
  { operation: "attachment.write", availability: "available" },
  { operation: "mention.write", availability: "available" },
  { operation: "message.edit", availability: "unsupported" },
  { operation: "message.delete", availability: "unsupported" },
  { operation: "reaction.read", availability: "unsupported" },
  { operation: "reaction.write", availability: "unsupported" },
  { operation: "thread.read", availability: "available" },
  { operation: "thread.write", availability: "unsupported" },
  { operation: "typing.write", availability: "unsupported" },
  { operation: "read_state.write", availability: "unsupported" },
  { operation: "poll.read", availability: "unsupported" },
  { operation: "poll.write", availability: "unsupported" },
  { operation: "voice_note.read", availability: "unsupported" },
  { operation: "voice_note.write", availability: "unsupported" },
  { operation: "call.read", availability: "unsupported" },
  { operation: "call.start", availability: "unsupported" },
];

function operation<A>(run: () => Promise<A>): Effect.Effect<A, ChannelOperationError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ChannelOperationError({
        accountId: DISCORD_LOCAL_ACCOUNT_ID,
        kind: String(cause).includes("not connected") ? "setup_required" : "transport_failed",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
}

export interface DiscordLocalSource {
  status(): Promise<DiscordSidecarStatus>;
  startLogin(): Promise<{ readonly qrUrl: string; readonly expiresInSeconds: number }>;
  logout(): Promise<void>;
  listConversations(): Promise<ReadonlyArray<DiscordSidecarConversation>>;
  listMessages(
    channelId: string,
    limit: number,
    beforeId?: string,
  ): Promise<ReadonlyArray<DiscordSidecarMessage>>;
  sendMessage(
    input: Parameters<DiscordSidecarClient["sendMessage"]>[0],
  ): Promise<DiscordSidecarMessage>;
}

function normalizeMessage(message: DiscordSidecarMessage): ChannelMessage {
  return {
    accountId: DISCORD_LOCAL_ACCOUNT_ID,
    conversationId: ChannelConversationId.make(message.channelId),
    messageId: ChannelMessageId.make(message.id),
    service: "discord",
    sender: message.author,
    text: message.content,
    sentAt: message.timestamp,
    ...(message.editedAt !== undefined ? { editedAt: message.editedAt } : {}),
    ...(message.replyToId !== undefined
      ? { replyToMessageId: ChannelMessageId.make(message.replyToId) }
      : {}),
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      ...(attachment.filename !== undefined ? { filename: attachment.filename } : {}),
      ...(attachment.contentType !== undefined ? { mediaType: attachment.contentType } : {}),
      ...(attachment.size !== undefined ? { byteSize: attachment.size } : {}),
      ...((attachment.proxyUrl ?? attachment.url) !== undefined
        ? { remoteUrl: attachment.proxyUrl ?? attachment.url }
        : {}),
    })),
    rawPermalink: `https://discord.com/channels/${message.guildId ?? "@me"}/${message.channelId}/${message.id}`,
  };
}

function accountFromStatus(status: DiscordSidecarStatus) {
  return {
    accountId: DISCORD_LOCAL_ACCOUNT_ID,
    service: "discord" as const,
    transport: "discord-local-user" as const,
    executionLocation: "device" as const,
    identityMode: "user" as const,
    label: status.user?.displayName ?? "Discord on this device",
    enabled: status.connected || status.loginPending,
    state: status.connected
      ? ("ready" as const)
      : status.loginPending
        ? ("syncing" as const)
        : ("setup_required" as const),
    capabilities,
    completeness: status.connected ? ("provider_scoped" as const) : ("unknown" as const),
    statusDetail: status.detail,
  };
}

export function makeDiscordLocalAdapter(client: DiscordLocalSource): ChannelAdapter {
  const discover = () =>
    operation(() => client.status()).pipe(
      Effect.map(accountFromStatus),
      Effect.catch((cause) =>
        Effect.succeed({
          accountId: DISCORD_LOCAL_ACCOUNT_ID,
          service: "discord" as const,
          transport: "discord-local-user" as const,
          executionLocation: "device" as const,
          identityMode: "user" as const,
          label: "Discord on this device",
          enabled: false,
          state: "unavailable" as const,
          capabilities: capabilities.map((capability) => ({
            ...capability,
            availability: "setup_required" as const,
          })),
          completeness: "unknown" as const,
          statusDetail: cause.message,
        }),
      ),
    );

  return {
    discover: discover(),
    configure: (enabled) =>
      enabled
        ? operation(() => client.startLogin()).pipe(
            Effect.map((login) => ({
              ...accountFromStatus({
                protocolVersion: 1,
                connected: false,
                loginPending: true,
                detail: "Approve this one-time Discord sign-in from a device already signed in.",
              }),
              setupUrl: login.qrUrl,
            })),
          )
        : operation(() => client.logout()).pipe(Effect.andThen(discover())),
    listConversations: operation(() => client.listConversations()).pipe(
      Effect.map((conversations) =>
        conversations.map((conversation) => ({
          accountId: DISCORD_LOCAL_ACCOUNT_ID,
          conversationId: ChannelConversationId.make(conversation.id),
          service: "discord" as const,
          title: conversation.title,
          kind: conversation.kind,
          participants: [...(conversation.participants ?? [])],
          ...(conversation.guildId !== undefined ? { containerId: conversation.guildId } : {}),
          ...(conversation.guildName !== undefined
            ? { containerTitle: conversation.guildName }
            : {}),
          ...(conversation.guildAvatarUrl !== undefined
            ? { containerAvatarUrl: conversation.guildAvatarUrl }
            : {}),
          ...(conversation.position !== undefined ? { position: conversation.position } : {}),
          ...(conversation.latestMessageAt !== undefined
            ? { latestMessageAt: conversation.latestMessageAt }
            : {}),
          completeness: "provider_scoped" as const,
        })),
      ),
    ),
    listMessages: (conversationId, limit = 50) =>
      operation(() => client.listMessages(conversationId, limit)).pipe(
        Effect.map((messages) => messages.map(normalizeMessage)),
      ),
    sendMessage: (input) =>
      operation(() =>
        client.sendMessage({
          channelId: input.conversationId,
          content: input.text,
          ...(input.replyToMessageId !== undefined ? { replyToId: input.replyToMessageId } : {}),
          ...(input.attachmentPaths !== undefined
            ? { attachmentPaths: input.attachmentPaths }
            : {}),
          idempotencyKey: input.idempotencyKey,
        }),
      ).pipe(
        Effect.map((message) => ({
          message: normalizeMessage(message),
          transport: "discord-local-user" as const,
        })),
      ),
  };
}
