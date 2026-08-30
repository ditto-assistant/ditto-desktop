import {
  ChannelAccountId,
  ChannelConversationId,
  ChannelMessageId,
  ChannelOperationError,
  type ChannelCapability,
  type ChannelConversation,
  type ChannelMessage,
  type ConnectedChannelAccount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type ChannelAdapter,
  type ChannelCommandRun,
  parseJsonRows,
  readNumber,
  readString,
  unknownRecord,
} from "./ChannelAdapter.ts";

export const DISCRAWL_ACCOUNT_ID = ChannelAccountId.make("discord:discrawl:local");

const unsupportedSend = [
  "message.send",
  "message.reply",
  "message.edit",
  "message.delete",
  "reaction.write",
  "thread.write",
  "attachment.write",
  "mention.write",
  "typing.write",
  "read_state.write",
  "poll.write",
  "voice_note.write",
  "call.start",
] as const;

export const DISCRAWL_CAPABILITIES: ReadonlyArray<ChannelCapability> = [
  { operation: "history.read", availability: "available" },
  {
    operation: "events.live",
    availability: "setup_required",
    reason:
      "Discrawl wiretap imports Discord Desktop cache snapshots; live bot events require bot mode.",
    setupAction: "Configure Discrawl bot sync or run wiretap on an interval.",
  },
  { operation: "reaction.read", availability: "available" },
  { operation: "thread.read", availability: "available" },
  { operation: "attachment.read", availability: "available" },
  { operation: "poll.read", availability: "unsupported" },
  { operation: "voice_note.read", availability: "available" },
  { operation: "call.read", availability: "unsupported" },
  ...unsupportedSend.map(
    (operation): ChannelCapability => ({
      operation,
      availability: "unsupported",
      reason:
        "Discrawl is a read-only archive and never extracts a Discord user token or runs a selfbot.",
    }),
  ),
];

function transportError(message: string): ChannelOperationError {
  return new ChannelOperationError({
    accountId: DISCRAWL_ACCOUNT_ID,
    kind: "transport_failed",
    message,
  });
}

function decodeRows(
  stdout: string,
  keys: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<unknown>, ChannelOperationError> {
  return Effect.try({
    try: () => parseJsonRows(stdout, keys),
    catch: (cause) =>
      new ChannelOperationError({
        accountId: DISCRAWL_ACCOUNT_ID,
        kind: "invalid_response",
        message: `Discrawl returned invalid JSON: ${String(cause)}`,
      }),
  });
}

function normalizeConversation(value: unknown): ChannelConversation | null {
  const row = unknownRecord(value);
  if (row === null) return null;
  const id = readString(row, "channel_id", "channelId", "id");
  if (id === undefined) return null;
  const guildId = readString(row, "guild_id", "guildId");
  const latestMessageAt = readString(row, "last_message_at", "lastMessageAt", "latest_at");
  const unreadCount = readNumber(row, "unread_count", "unreadCount");
  const direct = guildId === "@me" || row.dm === true || row.is_dm === true;
  return {
    accountId: DISCRAWL_ACCOUNT_ID,
    conversationId: ChannelConversationId.make(id),
    service: "discord",
    title: readString(row, "name", "channel_name", "display_name", "title") ?? `Discord ${id}`,
    kind: direct ? "direct" : row.thread === true ? "thread" : "channel",
    participants: [],
    ...(latestMessageAt !== undefined ? { latestMessageAt } : {}),
    ...(unreadCount !== undefined ? { unreadCount } : {}),
    completeness: "device_cache_partial",
  };
}

function normalizeMessage(value: unknown): ChannelMessage | null {
  const row = unknownRecord(value);
  if (row === null) return null;
  const id = readString(row, "message_id", "messageId", "id");
  const conversationId = readString(row, "channel_id", "channelId");
  if (id === undefined || conversationId === undefined) return null;
  const authorId = readString(row, "author_id", "authorId") ?? "unknown";
  const editedAt = readString(row, "edited_at", "editedAt");
  const replyToMessageId = readString(row, "reply_to_message_id", "replyToMessageId");
  const rawPermalink = readString(row, "url", "permalink");
  return {
    accountId: DISCRAWL_ACCOUNT_ID,
    conversationId: ChannelConversationId.make(conversationId),
    messageId: ChannelMessageId.make(id),
    service: "discord",
    sender: {
      id: authorId,
      displayName:
        readString(row, "author_display_name", "author_name", "display_name", "username") ??
        authorId,
    },
    text: readString(row, "content", "text", "body") ?? "",
    sentAt: readString(row, "timestamp", "sent_at", "created_at") ?? "1970-01-01T00:00:00.000Z",
    ...(editedAt !== undefined ? { editedAt } : {}),
    ...(replyToMessageId !== undefined
      ? { replyToMessageId: ChannelMessageId.make(replyToMessageId) }
      : {}),
    attachments: [],
    ...(rawPermalink !== undefined ? { rawPermalink } : {}),
  };
}

export function makeDiscrawlAdapter(run: ChannelCommandRun): ChannelAdapter {
  const execute = (args: ReadonlyArray<string>) =>
    run({ command: "discrawl", args, timeout: "30 seconds" }).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(transportError(result.stderr.trim() || `discrawl exited ${result.code}`)),
      ),
    );

  return {
    discover: execute(["--json", "status"]).pipe(
      Effect.map(
        (): ConnectedChannelAccount => ({
          accountId: DISCRAWL_ACCOUNT_ID,
          service: "discord",
          transport: "discord-discrawl",
          executionLocation: "device",
          identityMode: "archive",
          label: "Discord on this device",
          state: "ready",
          capabilities: [...DISCRAWL_CAPABILITIES],
          completeness: "device_cache_partial",
          statusDetail:
            "Discrawl archive is available. Run wiretap to refresh cached Discord data.",
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed({
          accountId: DISCRAWL_ACCOUNT_ID,
          service: "discord" as const,
          transport: "discord-discrawl" as const,
          executionLocation: "device" as const,
          identityMode: "archive" as const,
          label: "Discord on this device",
          state: "setup_required" as const,
          capabilities: [...DISCRAWL_CAPABILITIES],
          completeness: "unknown" as const,
          statusDetail: error.message,
        }),
      ),
    ),
    listConversations: Effect.all([
      execute(["--json", "channels", "list"]).pipe(
        Effect.flatMap((stdout) => decodeRows(stdout, ["channels", "rows", "data"])),
      ),
      execute(["--json", "dms"]).pipe(
        Effect.flatMap((stdout) =>
          decodeRows(stdout, ["conversations", "channels", "rows", "data"]),
        ),
        Effect.orElseSucceed(() => []),
      ),
    ]).pipe(
      Effect.map(([channels, dms]) =>
        [...channels, ...dms]
          .map(normalizeConversation)
          .filter((conversation): conversation is ChannelConversation => conversation !== null),
      ),
    ),
    listMessages: (conversationId, limit = 100) =>
      execute(["--json", "messages", "--channel", conversationId, "--last", String(limit)]).pipe(
        Effect.flatMap((stdout) => decodeRows(stdout, ["messages", "rows", "data"])),
        Effect.map((rows) =>
          rows
            .map(normalizeMessage)
            .filter((message): message is ChannelMessage => message !== null),
        ),
      ),
    sendMessage: () =>
      Effect.fail(
        new ChannelOperationError({
          accountId: DISCRAWL_ACCOUNT_ID,
          operation: "message.send",
          kind: "capability_unavailable",
          message:
            "Discrawl cannot send as a Discord user. Configure an official Discord bot transport for bot-identity replies.",
        }),
      ),
  };
}
