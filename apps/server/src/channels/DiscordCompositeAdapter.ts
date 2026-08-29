import {
  ChannelOperationError,
  type ChannelAttachment,
  type ChannelConversation,
  type ChannelMessage,
  type ConnectedChannelAccount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ChannelAdapter } from "./ChannelAdapter.ts";
import { DISCORD_LOCAL_ACCOUNT_ID } from "./DiscordLocalAdapter.ts";
import { DISCRAWL_ACCOUNT_ID } from "./DiscrawlAdapter.ts";

export const DISCORD_ACCOUNT_ID = DISCRAWL_ACCOUNT_ID;

type Attempt<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: ChannelOperationError };

function attempt<A>(effect: Effect.Effect<A, ChannelOperationError>): Effect.Effect<Attempt<A>> {
  return effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
  );
}

function logicalAccount(account: ConnectedChannelAccount): ConnectedChannelAccount {
  return { ...account, accountId: DISCORD_ACCOUNT_ID };
}

function logicalConversation(conversation: ChannelConversation): ChannelConversation {
  return { ...conversation, accountId: DISCORD_ACCOUNT_ID };
}

function logicalMessage(message: ChannelMessage): ChannelMessage {
  return { ...message, accountId: DISCORD_ACCOUNT_ID };
}

function latest(left?: string, right?: string): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left.localeCompare(right) >= 0 ? left : right;
}

function mergeAttachments(
  archive: ReadonlyArray<ChannelAttachment>,
  live: ReadonlyArray<ChannelAttachment>,
): ReadonlyArray<ChannelAttachment> {
  const byId = new Map(archive.map((attachment) => [attachment.id, attachment]));
  for (const attachment of live) {
    const cached = byId.get(attachment.id);
    byId.set(attachment.id, {
      ...cached,
      ...attachment,
      ...(cached?.cachedAttachmentId !== undefined
        ? { cachedAttachmentId: cached.cachedAttachmentId, cacheState: "cached" as const }
        : {}),
    });
  }
  return [...byId.values()];
}

function mergeConversations(
  archive: ReadonlyArray<ChannelConversation>,
  live: ReadonlyArray<ChannelConversation>,
): ReadonlyArray<ChannelConversation> {
  const byId = new Map(
    archive.map((conversation) => [conversation.conversationId, logicalConversation(conversation)]),
  );
  for (const conversation of live) {
    const cached = byId.get(conversation.conversationId);
    const latestMessageAt = latest(cached?.latestMessageAt, conversation.latestMessageAt);
    byId.set(conversation.conversationId, {
      ...cached,
      ...logicalConversation(conversation),
      participants:
        conversation.participants.length > 0
          ? conversation.participants
          : (cached?.participants ?? []),
      ...(latestMessageAt !== undefined ? { latestMessageAt } : {}),
      ...(cached?.unreadCount !== undefined ? { unreadCount: cached.unreadCount } : {}),
      completeness: "provider_scoped",
    });
  }
  return [...byId.values()];
}

function mergeMessages(
  archive: ReadonlyArray<ChannelMessage>,
  live: ReadonlyArray<ChannelMessage>,
): ReadonlyArray<ChannelMessage> {
  const byId = new Map(archive.map((message) => [message.messageId, logicalMessage(message)]));
  for (const message of live) {
    const cached = byId.get(message.messageId);
    byId.set(message.messageId, {
      ...cached,
      ...logicalMessage(message),
      text: message.text || cached?.text || "",
      sender:
        message.sender.id && message.sender.displayName !== "Unknown"
          ? message.sender
          : (cached?.sender ?? message.sender),
      attachments: mergeAttachments(cached?.attachments ?? [], message.attachments),
      ...(message.resolvedMentions !== undefined
        ? { resolvedMentions: message.resolvedMentions }
        : cached?.resolvedMentions !== undefined
          ? { resolvedMentions: cached.resolvedMentions }
          : {}),
    });
  }
  return [...byId.values()].sort((left, right) => left.sentAt.localeCompare(right.sentAt));
}

export function makeDiscordCompositeAdapter(input: {
  readonly protocol: ChannelAdapter;
  readonly archive: ChannelAdapter;
}): ChannelAdapter {
  const discover = Effect.all(
    [attempt(input.protocol.discover), attempt(input.archive.discover)] as const,
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap(([protocol, archive]) => {
      if (protocol.ok && (protocol.value.state === "ready" || protocol.value.state === "syncing")) {
        return Effect.succeed(logicalAccount(protocol.value));
      }
      if (archive.ok) {
        const protocolAccount = protocol.ok ? protocol.value : undefined;
        return Effect.succeed({
          ...logicalAccount(archive.value),
          statusDetail:
            protocolAccount?.statusDetail ??
            "History is available locally. Connect Discord for live sync and replies.",
          capabilities: archive.value.capabilities.map((capability) =>
            capability.operation === "message.send" || capability.operation === "message.reply"
              ? {
                  ...capability,
                  availability: "setup_required" as const,
                  reason: "Connect the live Discord transport to reply from Ditto.",
                }
              : capability,
          ),
        });
      }
      return Effect.fail(protocol.ok ? archive.error : protocol.error);
    }),
  );

  return {
    discover,
    configure: (enabled) => {
      const configure = input.protocol.configure;
      if (configure === undefined) {
        return Effect.fail(
          new ChannelOperationError({
            accountId: DISCORD_ACCOUNT_ID,
            kind: "capability_unavailable",
            message: "The live Discord transport cannot be configured in this build.",
          }),
        );
      }
      const configured = configure(enabled);
      return enabled
        ? configured.pipe(Effect.map(logicalAccount))
        : configured.pipe(Effect.andThen(discover));
    },
    listConversations: Effect.all(
      [
        attempt(input.protocol.listConversations),
        attempt(input.archive.listConversations),
      ] as const,
      { concurrency: "unbounded" },
    ).pipe(
      Effect.flatMap(([protocol, archive]) => {
        if (protocol.ok) {
          return Effect.succeed(
            mergeConversations(archive.ok ? archive.value : [], protocol.value),
          );
        }
        return archive.ok
          ? Effect.succeed(archive.value.map(logicalConversation))
          : Effect.fail(protocol.error);
      }),
    ),
    listMessages: (conversationId, limit) =>
      Effect.all(
        [
          attempt(input.protocol.listMessages(conversationId, limit)),
          attempt(input.archive.listMessages(conversationId, limit)),
        ] as const,
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap(([protocol, archive]) => {
          if (protocol.ok) {
            return Effect.succeed(mergeMessages(archive.ok ? archive.value : [], protocol.value));
          }
          return archive.ok
            ? Effect.succeed(archive.value.map(logicalMessage))
            : Effect.fail(protocol.error);
        }),
      ),
    sendMessage: (message) =>
      input.protocol.sendMessage({ ...message, accountId: DISCORD_LOCAL_ACCOUNT_ID }).pipe(
        Effect.map((result) => ({
          ...result,
          message: logicalMessage(result.message),
        })),
      ),
  };
}
