import {
  ChannelAccountId,
  ChannelConversationId,
  ChannelMessageId,
  ChannelOperationError,
  type ChannelAttachment,
  type ChannelCapability,
  type ChannelConversation,
  type ChannelMessage,
  type ChannelResolvedMention,
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
import type { DiscordMediaCache } from "./DiscordMediaCache.ts";

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

function decodeSqlRows(
  stdout: string,
): Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, ChannelOperationError> {
  return Effect.try({
    try: () => parseSqlRows(stdout),
    catch: (cause) =>
      new ChannelOperationError({
        accountId: DISCRAWL_ACCOUNT_ID,
        kind: "invalid_response",
        message: `Discrawl returned invalid SQL JSON: ${String(cause)}`,
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
  const position = readNumber(row, "position");
  const direct = guildId === "@me" || row.dm === true || row.is_dm === true;
  return {
    accountId: DISCRAWL_ACCOUNT_ID,
    conversationId: ChannelConversationId.make(id),
    service: "discord",
    title: readString(row, "name", "channel_name", "display_name", "title") ?? `Discord ${id}`,
    kind: direct ? "direct" : row.thread === true ? "thread" : "channel",
    participants: [],
    ...(guildId !== undefined && guildId !== "@me" ? { containerId: guildId } : {}),
    ...(position !== undefined ? { position } : {}),
    ...(latestMessageAt !== undefined ? { latestMessageAt } : {}),
    ...(unreadCount !== undefined ? { unreadCount } : {}),
    completeness: "device_cache_partial",
  };
}

function parseSqlRows(stdout: string): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const parsed = unknownRecord(JSON.parse(stdout));
  if (parsed === null || !Array.isArray(parsed.columns) || !Array.isArray(parsed.rows)) return [];
  const columns = parsed.columns.filter((column): column is string => typeof column === "string");
  return parsed.rows.flatMap((row) => {
    if (!Array.isArray(row)) return [];
    return [Object.fromEntries(columns.map((column, index) => [column, row[index]]))];
  });
}

function discordAvatarUrl(userId: string, avatar?: string): string | undefined {
  if (avatar?.startsWith("http://") || avatar?.startsWith("https://")) return avatar;
  if (avatar && /^\d+$/.test(userId)) {
    return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=80`;
  }
  if (!/^\d+$/.test(userId)) return undefined;
  const index = Number((BigInt(userId) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function discordGuildAvatarUrl(guildId: string, icon?: string): string | undefined {
  if (icon?.startsWith("http://") || icon?.startsWith("https://")) return icon;
  return icon ? `https://cdn.discordapp.com/icons/${guildId}/${icon}.png?size=80` : undefined;
}

function normalizeAttachment(
  value: unknown,
): { readonly messageId: string; readonly attachment: ChannelAttachment } | null {
  const row = unknownRecord(value);
  if (row === null) return null;
  const id = readString(row, "attachment_id", "attachmentId", "id");
  const messageId = readString(row, "message_id", "messageId");
  if (id === undefined || messageId === undefined) return null;
  const filename = readString(row, "filename", "name");
  const mediaType = readString(row, "content_type", "contentType", "media_type", "mediaType");
  const byteSize = readNumber(row, "size", "byte_size", "byteSize");
  const remoteUrl = readString(row, "proxy_url", "proxyUrl", "url");
  const localPath = readString(row, "media_path", "mediaPath", "local_path", "localPath");
  return {
    messageId,
    attachment: {
      id,
      ...(filename !== undefined ? { filename } : {}),
      ...(mediaType !== undefined ? { mediaType } : {}),
      ...(byteSize !== undefined ? { byteSize } : {}),
      ...(remoteUrl !== undefined ? { remoteUrl } : {}),
      ...(localPath !== undefined ? { localPath } : {}),
    },
  };
}

function normalizeMessage(
  value: unknown,
  selfAuthorId: string | undefined,
  attachmentsByMessage: ReadonlyMap<string, ReadonlyArray<ChannelAttachment>>,
  resolvedMentionByToken: ReadonlyMap<string, ChannelResolvedMention>,
): ChannelMessage | null {
  const row = unknownRecord(value);
  if (row === null) return null;
  const id = readString(row, "message_id", "messageId", "id");
  const conversationId = readString(row, "channel_id", "channelId");
  if (id === undefined || conversationId === undefined) return null;
  const authorId = readString(row, "author_id", "authorId") ?? "unknown";
  const editedAt = readString(row, "edited_at", "editedAt");
  const replyToMessageId = readString(row, "reply_to_message_id", "replyToMessageId");
  const rawPermalink = readString(row, "url", "permalink");
  const avatarUrl = discordAvatarUrl(
    authorId,
    readString(row, "author_avatar", "authorAvatar", "avatar"),
  );
  const text = readString(row, "content", "text", "body") ?? "";
  const resolvedMentions = [...discordMentionTokens(text)].flatMap((token) => {
    const mention = resolvedMentionByToken.get(token);
    return mention === undefined ? [] : [mention];
  });
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
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      isSelf: selfAuthorId !== undefined && authorId === selfAuthorId,
    },
    text,
    sentAt: readString(row, "timestamp", "sent_at", "created_at") ?? "1970-01-01T00:00:00.000Z",
    ...(editedAt !== undefined ? { editedAt } : {}),
    ...(replyToMessageId !== undefined
      ? { replyToMessageId: ChannelMessageId.make(replyToMessageId) }
      : {}),
    attachments: [...(attachmentsByMessage.get(id) ?? [])],
    ...(resolvedMentions.length > 0 ? { resolvedMentions } : {}),
    ...(rawPermalink !== undefined ? { rawPermalink } : {}),
  };
}

const DISCORD_MENTION_PATTERN = /<(@!?|#|@&)(\d+)>/g;

function discordMentionTokens(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(DISCORD_MENTION_PATTERN)) {
    const token = match[0];
    if (token !== undefined) tokens.add(token);
  }
  return tokens;
}

function mentionLookupSql(rows: ReadonlyArray<unknown>): string | null {
  const userIds = new Set<string>();
  const channelIds = new Set<string>();
  for (const value of rows) {
    const row = unknownRecord(value);
    const text = row === null ? undefined : readString(row, "content", "text", "body");
    if (text === undefined) continue;
    for (const token of discordMentionTokens(text)) {
      const match = /^<(@!?|#|@&)(\d+)>$/.exec(token);
      const kind = match?.[1];
      const id = match?.[2];
      if (id === undefined) continue;
      if (kind === "#") channelIds.add(id);
      else if (kind === "@" || kind === "@!") userIds.add(id);
    }
  }

  const selects: Array<string> = [];
  if (userIds.size > 0) {
    const ids = [...userIds]
      .slice(0, 500)
      .map((id) => `'${id}'`)
      .join(",");
    selects.push(
      `SELECT 'user' AS kind, author_id AS id, MAX(COALESCE(json_extract(raw_json, '$.author.global_name'), json_extract(raw_json, '$.author.username'), author_id)) AS display_name FROM messages WHERE author_id IN (${ids}) GROUP BY author_id`,
    );
  }
  if (channelIds.size > 0) {
    const ids = [...channelIds]
      .slice(0, 500)
      .map((id) => `'${id}'`)
      .join(",");
    selects.push(
      `SELECT 'channel' AS kind, id, name AS display_name FROM channels WHERE id IN (${ids})`,
    );
  }
  return selects.length === 0 ? null : selects.join(" UNION ALL ");
}

function resolvedMentionMap(
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ReadonlyMap<string, ChannelResolvedMention> {
  const mentions = new Map<string, ChannelResolvedMention>();
  for (const row of rows) {
    const kind = readString(row, "kind");
    const id = readString(row, "id");
    const displayName = readString(row, "display_name");
    if ((kind !== "user" && kind !== "channel") || id === undefined || displayName === undefined) {
      continue;
    }
    const mention: ChannelResolvedMention = { id, kind, displayName };
    mentions.set(kind === "channel" ? `<#${id}>` : `<@${id}>`, mention);
    if (kind === "user") mentions.set(`<@!${id}>`, mention);
  }
  return mentions;
}

type DiscrawlRuntime = Pick<
  DiscrawlManager,
  "configure" | "execute" | "getSyncState" | "isDiscordInstalled" | "isEnabled"
>;

function runtimeFromRun(run: ChannelCommandRun): DiscrawlRuntime {
  return {
    configure: () => Effect.void,
    execute: (args) => run({ command: "discrawl", args, timeout: "30 seconds" }),
    getSyncState: () => Effect.succeed({ state: "idle" as const }),
    isDiscordInstalled: () => Effect.succeed(true),
    isEnabled: () => Effect.succeed(true),
  };
}

export function makeDiscrawlAdapter(
  input: ChannelCommandRun | DiscrawlRuntime,
  options: { readonly mediaCache?: DiscordMediaCache } = {},
): ChannelAdapter {
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
          execute(["--json", "sql", "SELECT id, name, icon FROM guilds"]).pipe(
            Effect.flatMap(decodeSqlRows),
            Effect.orElseSucceed(() => []),
          ),
          execute([
            "--json",
            "sql",
            "WITH self AS (SELECT author_id FROM messages WHERE guild_id = '@me' AND author_id <> '' GROUP BY author_id ORDER BY COUNT(DISTINCT channel_id) DESC LIMIT 1) SELECT m.channel_id, m.author_id, COALESCE(json_extract(m.raw_json, '$.author.global_name'), json_extract(m.raw_json, '$.author.username'), m.author_id) AS display_name FROM messages m, self WHERE m.guild_id = '@me' AND m.author_id <> '' AND m.author_id <> self.author_id GROUP BY m.channel_id, m.author_id ORDER BY m.channel_id, COUNT(*) DESC",
          ]).pipe(
            Effect.flatMap(decodeSqlRows),
            Effect.orElseSucceed(() => []),
          ),
        ]),
      ),
      Effect.map(([channels, dms, guildRows, dmParticipantRows]) => {
        const guilds = new Map(
          guildRows.flatMap((row) => {
            const id = readString(row, "id");
            const name = readString(row, "name");
            if (id === undefined || name === undefined) return [];
            return [[id, { name, icon: readString(row, "icon") }] as const];
          }),
        );
        const dmParticipants = new Map<string, ChannelConversation["participants"][number]>();
        for (const row of dmParticipantRows) {
          const channelId = readString(row, "channel_id");
          const authorId = readString(row, "author_id");
          if (channelId === undefined || authorId === undefined || dmParticipants.has(channelId)) {
            continue;
          }
          const avatarUrl = discordAvatarUrl(authorId);
          dmParticipants.set(channelId, {
            id: authorId,
            displayName: readString(row, "display_name") ?? authorId,
            ...(avatarUrl !== undefined ? { avatarUrl } : {}),
            isSelf: false,
          });
        }

        return [...channels, ...dms].flatMap((row) => {
          const conversation = normalizeConversation(row);
          if (conversation === null) return [];
          if (conversation.kind === "direct") {
            const participant = dmParticipants.get(conversation.conversationId);
            return [
              participant === undefined
                ? conversation
                : { ...conversation, participants: [participant], title: participant.displayName },
            ];
          }
          const containerId = conversation.containerId;
          const guild = containerId === undefined ? undefined : guilds.get(containerId);
          if (containerId === undefined || guild === undefined) return [conversation];
          const containerAvatarUrl = discordGuildAvatarUrl(containerId, guild.icon);
          return [
            {
              ...conversation,
              containerTitle: guild.name,
              ...(containerAvatarUrl !== undefined ? { containerAvatarUrl } : {}),
            },
          ];
        });
      }),
    ),
    listMessages: (conversationId, limit = 100) =>
      runtime.isEnabled().pipe(
        Effect.flatMap((enabled) =>
          enabled
            ? Effect.void
            : Effect.fail(
                new ChannelOperationError({
                  accountId: DISCRAWL_ACCOUNT_ID,
                  kind: "setup_required",
                  message: "Turn on Discord sync before opening its messages.",
                }),
              ),
        ),
        Effect.andThen(
          Effect.all([
            execute([
              "--json",
              "messages",
              "--channel",
              conversationId,
              "--last",
              String(limit),
            ]).pipe(Effect.flatMap((stdout) => decodeRows(stdout, ["messages", "rows", "data"]))),
            execute([
              "--json",
              "attachments",
              "--channel",
              conversationId,
              "--limit",
              String(Math.max(limit, 200)),
            ]).pipe(
              Effect.flatMap((stdout) => decodeRows(stdout, ["attachments", "rows", "data"])),
              Effect.orElseSucceed(() => []),
            ),
            execute([
              "--json",
              "sql",
              "SELECT author_id FROM messages WHERE guild_id = '@me' AND author_id <> '' GROUP BY author_id ORDER BY COUNT(DISTINCT channel_id) DESC LIMIT 1",
            ]).pipe(
              Effect.flatMap(decodeSqlRows),
              Effect.orElseSucceed(() => []),
            ),
          ]),
        ),
        Effect.flatMap(([rows, attachmentRows, selfRows]) => {
          const lookupSql = mentionLookupSql(rows);
          return Effect.map(
            lookupSql === null
              ? Effect.succeed([])
              : execute(["--json", "sql", lookupSql]).pipe(
                  Effect.flatMap(decodeSqlRows),
                  Effect.orElseSucceed(() => []),
                ),
            (mentionRows) => ({ rows, attachmentRows, selfRows, mentionRows }),
          );
        }),
        Effect.flatMap(({ rows, attachmentRows, selfRows, mentionRows }) =>
          Effect.gen(function* () {
            const attachmentsByMessage = new Map<string, Array<ChannelAttachment>>();
            const normalizedAttachments = attachmentRows.flatMap((value) => {
              const attachment = normalizeAttachment(value);
              return attachment === null ? [] : [attachment];
            });
            const cachedAttachments =
              options.mediaCache === undefined
                ? normalizedAttachments.map((normalized) => ({ normalized, cached: undefined }))
                : yield* Effect.forEach(
                    normalizedAttachments,
                    (normalized) =>
                      Effect.promise(() => options.mediaCache!.cache(normalized.attachment)).pipe(
                        Effect.map((cached) => ({ normalized, cached })),
                      ),
                    { concurrency: 4 },
                  );
            for (const { normalized, cached } of cachedAttachments) {
              const existing = attachmentsByMessage.get(normalized.messageId) ?? [];
              existing.push({
                ...normalized.attachment,
                ...(cached?.state === "cached"
                  ? { cachedAttachmentId: cached.attachmentId, cacheState: cached.state }
                  : cached === undefined
                    ? {}
                    : { cacheState: cached.state }),
              });
              attachmentsByMessage.set(normalized.messageId, existing);
            }
            const selfAuthorId = readString(selfRows[0] ?? {}, "author_id");
            const mentions = resolvedMentionMap(mentionRows);
            return rows
              .map((row) => normalizeMessage(row, selfAuthorId, attachmentsByMessage, mentions))
              .filter((message): message is ChannelMessage => message !== null);
          }),
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
          state: discordInstalled ? ("setup_required" as const) : ("unavailable" as const),
          detail: discordInstalled
            ? "Connect Discord to import chats stored on this device."
            : "Install and sign in to Discord first.",
        };
      }
      const sync = yield* runtime.getSyncState();
      if (sync.state === "syncing") {
        return {
          enabled,
          discordInstalled,
          state: "syncing" as const,
          detail: "Connecting to Discord…",
        };
      }
      if (sync.state === "error") {
        return {
          enabled,
          discordInstalled,
          state: "error" as const,
          detail: "Discord could not finish connecting. Try again.",
        };
      }
      const status = yield* Effect.result(execute(["--json", "status"]));
      return status._tag === "Success"
        ? {
            enabled,
            discordInstalled,
            state: "ready" as const,
            detail: "Discord chats are available on this device.",
          }
        : {
            enabled,
            discordInstalled,
            state: "error" as const,
            detail: "Discord could not finish connecting. Try again.",
          };
    }).pipe(
      Effect.map(
        ({ enabled, state, detail }): ConnectedChannelAccount => ({
          accountId: DISCRAWL_ACCOUNT_ID,
          service: "discord",
          transport: "discord-discrawl",
          executionLocation: "device",
          identityMode: "archive",
          label: "Discord on this device",
          enabled,
          state,
          capabilities: [...DISCRAWL_CAPABILITIES],
          completeness: "device_cache_partial",
          statusDetail: detail,
        }),
      ),
    );
  }
}
