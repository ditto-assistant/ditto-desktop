export type LocalService = "discord" | "telegram" | "imessage" | "googlemessages";
export const localServices: LocalService[] = ["discord", "telegram", "imessage", "googlemessages"];
export const localServiceName = (service: LocalService) =>
  ({
    discord: "Discord",
    telegram: "Telegram",
    imessage: "iMessage",
    googlemessages: "Google Messages",
  })[service];

export interface LocalConversation {
  id: string;
  title: string;
  kind: string;
  handle?: string;
  guildName?: string;
  latestMessageAt?: string;
}
export interface LocalStatus {
  connected: boolean;
  configured?: boolean;
  restoring?: boolean;
  loginPending?: boolean;
  qrDataUrl?: string;
  qrExpiresAt?: string;
  detail?: string;
  user?: { id?: string; displayName?: string };
}
export interface LocalMessage {
  id: string;
  content?: string;
  timestamp: string;
  editedAt?: string;
  replyToId?: string;
  author?: { id?: string; displayName?: string; avatarUrl?: string; isSelf?: boolean };
  attachments?: { filename?: string; contentType?: string; url?: string }[];
}
export interface LocalSelection {
  service: LocalService;
  conversation?: LocalConversation;
}
// Local identifiers never enter cloud session APIs or collide with provider ids.
export const localSessionID = (service: LocalService, id: string) =>
  `desktop-local:${service}:${encodeURIComponent(id)}`;
export const isLocalSessionID = (id: string) => id.startsWith("desktop-local:");
export const localError = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
export const canSendLocally = (selection: LocalSelection) =>
  !!selection.conversation &&
  (selection.service !== "imessage" ||
    (selection.conversation.kind === "direct" && !!selection.conversation.handle));

const safeRemoteURL = (url?: string) => (/^https:\/\//i.test(url ?? "") ? url! : "");
const timestamp = (value: string) => {
  // SQLite's iMessage timestamps are UTC without an explicit offset.
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    ? value.replace(" ", "T") + "Z"
    : value;
  return Number.isFinite(Date.parse(normalized)) ? normalized : "1970-01-01T00:00:00Z";
};
export function localConnectorMessage(
  service: LocalService,
  conversationID: string,
  message: LocalMessage,
) {
  const prefix = `${localSessionID(service, conversationID)}:message:`;
  return {
    id: prefix + message.id,
    messageId: prefix + message.id,
    clientActionId: "",
    senderId: message.author?.id ?? "",
    senderName: message.author?.displayName || (message.author?.isSelf ? "You" : "Unknown"),
    senderAvatarUrl: safeRemoteURL(message.author?.avatarUrl),
    text: message.content ?? "",
    sentAt: timestamp(message.timestamp),
    editedAt: message.editedAt ? timestamp(message.editedAt) : "",
    replyToMessageId: message.replyToId ? prefix + message.replyToId : "",
    reactions: [],
    isFromSelf: message.author?.isSelf === true,
    attachments: (message.attachments ?? []).map((attachment) => ({
      type: (attachment.contentType?.split("/")[0] === "image"
        ? "image"
        : attachment.contentType?.split("/")[0] === "video"
          ? "video"
          : attachment.contentType?.split("/")[0] === "audio"
            ? "audio"
            : "file") as "image" | "video" | "audio" | "file",
      name: attachment.filename || "Attachment",
      url: safeRemoteURL(attachment.url),
    })),
  };
}

/** Captures the destination before awaiting IPC; a later chat switch cannot retarget a send. */
export async function sendLocalMessage(
  bridge: {
    channelSend: (
      service: LocalService,
      id: string,
      text: string,
      handle?: string,
    ) => Promise<unknown>;
  },
  selection: LocalSelection,
  text: string,
  options?: {
    files?: readonly unknown[];
    replyToMessageId?: string;
    mentions?: readonly unknown[];
  },
) {
  if (!canSendLocally(selection)) throw new Error("This conversation is read-only on this Mac.");
  if (options?.files?.length || options?.replyToMessageId || options?.mentions?.length)
    throw new Error(
      "Local chats currently send text only. Remove attachments, replies, and mentions before sending.",
    );
  const content = text.trim();
  if (!content || content.length > 8000) throw new Error("Enter a message under 8,000 characters.");
  const { service, conversation } = selection;
  return bridge.channelSend(service, conversation!.id, content, conversation!.handle);
}
