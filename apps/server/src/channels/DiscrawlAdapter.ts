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
import type { DiscrawlManager } from "./DiscrawlManager.ts";

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

type DiscrawlRuntime = Pick<
  DiscrawlManager,
  "configure" | "execute" | "isDiscordInstalled" | "isEnabled"
>;

function runtimeFromRun(run: ChannelCommandRun): DiscrawlRuntime {
  return {
    configure: () => Effect.void,
    execute: (args) => run({ command: "discrawl", args, timeout: "30 seconds" }),
    isDiscordInstalled: () => Effect.succeed(true),
    isEnabled: () => Effect.succeed(true),
  };
}

export function makeDiscrawlAdapter(input: ChannelCommandRun | DiscrawlRuntime): ChannelAdapter {
  const runtime = typeof input === "function" ? runtimeFromRun(input) : input;
  const execute = (args: ReadonlyArray<string>) =>
    runtime
      .execute(args)
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(transportError(result.stderr.trim() || `discrawl exited ${result.code}`)),
        ),
      );

  return {
    configure: (enabled) =>
      runtime.configure(enabled).pipe(Effect.andThen(Effect.suspend(() => discoverAccount()))),
    discover: Effect.suspend(() => discoverAccount()),
    listConversations: runtime.isEnabled().pipe(
      Effect.flatMap((enabled) =>
        enabled
          ? Effect.void
          : Effect.fail(
              new ChannelOperationError({
                accountId: DISCRAWL_ACCOUNT_ID,
                kind: "setup_required",
                message: "Turn on Discord sync before opening its conversations.",
              }),
            ),
      ),
      Effect.andThen(
        Effect.all([
          execute(["--json", "channels", "list"]).pipe(
            Effect.flatMap((stdout) => decodeRows(stdout, ["channels", "rows", "data"])),
          ),
          execute(["--json", "dms"]).pipe(
            Effect.flatMap((stdout) =>
              decodeRows(stdout, ["conversations", "channels", "rows", "data"]),
            ),
            Effect.orElseSucceed(() => []),
          ),
        ]),
      ),
      Effect.map(([channels, dms]) =>
        [...channels, ...dms]
          .map(normalizeConversation)
          .filter((conversation): conversation is ChannelConversation => conversation !== null),
      ),
    ),
    listMessages: (conversationId, limit = 100) =>
      runtime.isEnabled().pipe(
        Effect.flatMap((enabled) =>
          enabled
            ? execute(["--json", "messages", "--channel", conversationId, "--last", String(limit)])
            : Effect.fail(
                new ChannelOperationError({
                  accountId: DISCRAWL_ACCOUNT_ID,
                  kind: "setup_required",
                  message: "Turn on Discord sync before opening its messages.",
                }),
              ),
        ),
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

  function discoverAccount(): Effect.Effect<ConnectedChannelAccount> {
    return Effect.gen(function* () {
      const enabled = yield* runtime.isEnabled();
      const discordInstalled = yield* runtime.isDiscordInstalled();
      if (!enabled) {
        return {
          enabled,
          discordInstalled,
          ready: false,
          detail: "Turn on Discord sync to install Discrawl and import the local Discord cache.",
        };
      }
      const status = yield* Effect.result(execute(["--json", "status"]));
      return status._tag === "Success"
        ? {
            enabled,
            discordInstalled,
            ready: true,
            detail:
              "Discrawl archive is available. Toggle sync again to refresh the Discord cache.",
          }
        : {
            enabled,
            discordInstalled,
            ready: false,
            detail: status.failure.message,
          };
    }).pipe(
      Effect.map(
        ({ enabled, discordInstalled, ready, detail }): ConnectedChannelAccount => ({
          accountId: DISCRAWL_ACCOUNT_ID,
          service: "discord",
          transport: "discord-discrawl",
          executionLocation: "device",
          identityMode: "archive",
          label: "Discord on this device",
          enabled,
          state: ready ? "ready" : discordInstalled ? "setup_required" : "unavailable",
          capabilities: [...DISCRAWL_CAPABILITIES],
          completeness: "device_cache_partial",
          statusDetail: detail,
        }),
      ),
    );
  }
}
