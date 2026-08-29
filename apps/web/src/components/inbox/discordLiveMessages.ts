import type {
  ChannelConversation,
  ChannelMessage,
  ConnectedChannelAccount,
  DiscordAccessibilitySnapshotMessage,
  DiscordAccessibilitySnapshotResult,
} from "@t3tools/contracts";

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll(/\s+/g, " ");
}

function senderId(author: string): string {
  let hash = 2_166_136_261;
  for (const character of normalize(author)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `discord-ax-author-${(hash >>> 0).toString(16)}`;
}

function attachmentFilename(
  attachment: DiscordAccessibilitySnapshotMessage["attachments"][number],
): string {
  if (attachment.indicator.trim().length > 0 && attachment.indicator !== "Attachment") {
    return attachment.indicator;
  }
  if (attachment.url) {
    try {
      const filename = new URL(attachment.url).pathname.split("/").at(-1);
      if (filename) return decodeURIComponent(filename);
    } catch {
      // The typed snapshot still permits a useful attachment indicator without a URL.
    }
  }
  return "Discord attachment";
}

function toChannelMessage(
  account: ConnectedChannelAccount,
  conversation: ChannelConversation,
  snapshot: DiscordAccessibilitySnapshotResult,
  message: DiscordAccessibilitySnapshotMessage,
): ChannelMessage {
  return {
    accountId: account.accountId,
    conversationId: conversation.conversationId,
    messageId: message.id as ChannelMessage["messageId"],
    service: "discord",
    sender: {
      id: senderId(message.author),
      displayName: message.author,
    },
    text: message.content,
    sentAt: message.sentAt ?? snapshot.observedAt,
    attachments: message.attachments.map((attachment, index) => ({
      id: `discord-ax-${message.id}-${index}`,
      filename: attachmentFilename(attachment),
      ...(attachment.url ? { remoteUrl: attachment.url } : {}),
    })),
  };
}

function contentSignature(message: ChannelMessage): string {
  return [
    normalize(message.sender.displayName),
    normalize(message.text),
    message.sentAt.slice(0, 16),
    String(message.attachments.length),
  ].join("\u0000");
}

/** Overlays the verified, currently loaded AX tail without replacing Discrawl history. */
export function mergeDiscordLiveSnapshot(
  archived: ReadonlyArray<ChannelMessage>,
  account: ConnectedChannelAccount,
  conversation: ChannelConversation,
  snapshot: DiscordAccessibilitySnapshotResult | null,
): ReadonlyArray<ChannelMessage> {
  if (
    snapshot === null ||
    !snapshot.targetVerified ||
    snapshot.accountId !== account.accountId ||
    snapshot.conversationId !== conversation.conversationId
  ) {
    return archived;
  }
  const merged = [...archived];
  const ids = new Set<string>(archived.map((message) => message.messageId));
  const signatures = new Set(archived.map(contentSignature));
  for (const live of snapshot.messages) {
    if (live.provenance !== "discord_accessibility_live" || ids.has(live.id)) continue;
    const message = toChannelMessage(account, conversation, snapshot, live);
    const signature = contentSignature(message);
    if (signatures.has(signature)) continue;
    ids.add(message.messageId);
    signatures.add(signature);
    merged.push(message);
  }
  return merged.sort((left, right) =>
    left.sentAt === right.sentAt
      ? left.messageId.localeCompare(right.messageId)
      : left.sentAt.localeCompare(right.sentAt),
  );
}
