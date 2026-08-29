import * as Schema from "effect/Schema";

/** A chat brand. One service may expose multiple transports for one account. */
export const ChatService = Schema.Literals([
  "discord",
  "imessage",
  "telegram",
  "slack",
  "whatsapp",
]);
export type ChatService = typeof ChatService.Type;

export const ChannelTransportKind = Schema.Literals([
  "discord-discrawl",
  "discord-bot",
  "imessage-macos",
  "telegram-bot",
  "telegram-user",
  "slack-app",
  "whatsapp-companion",
  "whatsapp-business",
]);
export type ChannelTransportKind = typeof ChannelTransportKind.Type;

export const ChannelExecutionLocation = Schema.Literals(["device", "hosted"]);
export type ChannelExecutionLocation = typeof ChannelExecutionLocation.Type;

export const ChannelIdentityMode = Schema.Literals(["archive", "bot", "user"]);
export type ChannelIdentityMode = typeof ChannelIdentityMode.Type;

export const ChannelAccountId = Schema.String.pipe(Schema.brand("ChannelAccountId"));
export type ChannelAccountId = typeof ChannelAccountId.Type;

export const ChannelConversationId = Schema.String.pipe(Schema.brand("ChannelConversationId"));
export type ChannelConversationId = typeof ChannelConversationId.Type;

export const ChannelMessageId = Schema.String.pipe(Schema.brand("ChannelMessageId"));
export type ChannelMessageId = typeof ChannelMessageId.Type;

export const ChannelOperation = Schema.Literals([
  "history.read",
  "events.live",
  "message.send",
  "message.reply",
  "message.edit",
  "message.delete",
  "reaction.read",
  "reaction.write",
  "thread.read",
  "thread.write",
  "attachment.read",
  "attachment.write",
  "mention.write",
  "typing.write",
  "read_state.write",
  "poll.read",
  "poll.write",
  "voice_note.read",
  "voice_note.write",
  "call.read",
  "call.start",
]);
export type ChannelOperation = typeof ChannelOperation.Type;

export const ChannelCapabilityAvailability = Schema.Literals([
  "available",
  "permission_required",
  "setup_required",
  "unsupported",
]);
export type ChannelCapabilityAvailability = typeof ChannelCapabilityAvailability.Type;

export const ChannelCapability = Schema.Struct({
  operation: ChannelOperation,
  availability: ChannelCapabilityAvailability,
  reason: Schema.optionalKey(Schema.String),
  setupAction: Schema.optionalKey(Schema.String),
});
export type ChannelCapability = typeof ChannelCapability.Type;

export const ChannelDataCompleteness = Schema.Literals([
  "complete",
  "provider_scoped",
  "device_cache_partial",
  "unknown",
]);
export type ChannelDataCompleteness = typeof ChannelDataCompleteness.Type;

export const ChannelConnectionState = Schema.Literals([
  "ready",
  "permission_required",
  "setup_required",
  "syncing",
  "unavailable",
  "error",
]);
export type ChannelConnectionState = typeof ChannelConnectionState.Type;

export const ConnectedChannelAccount = Schema.Struct({
  accountId: ChannelAccountId,
  service: ChatService,
  transport: ChannelTransportKind,
  executionLocation: ChannelExecutionLocation,
  identityMode: ChannelIdentityMode,
  label: Schema.String,
  enabled: Schema.Boolean,
  state: ChannelConnectionState,
  capabilities: Schema.Array(ChannelCapability),
  completeness: ChannelDataCompleteness,
  lastObservedAt: Schema.optionalKey(Schema.String),
  statusDetail: Schema.optionalKey(Schema.String),
});
export type ConnectedChannelAccount = typeof ConnectedChannelAccount.Type;

export const ChannelConfigureAccountInput = Schema.Struct({
  accountId: ChannelAccountId,
  enabled: Schema.Boolean,
});
export type ChannelConfigureAccountInput = typeof ChannelConfigureAccountInput.Type;

export const ChannelConfigureAccountResult = Schema.Struct({
  account: ConnectedChannelAccount,
});
export type ChannelConfigureAccountResult = typeof ChannelConfigureAccountResult.Type;

export const ChannelParticipant = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  handle: Schema.optionalKey(Schema.String),
  avatarUrl: Schema.optionalKey(Schema.String),
  isSelf: Schema.optionalKey(Schema.Boolean),
  isBot: Schema.optionalKey(Schema.Boolean),
});
export type ChannelParticipant = typeof ChannelParticipant.Type;

export const ChannelAttachment = Schema.Struct({
  id: Schema.String,
  filename: Schema.optionalKey(Schema.String),
  mediaType: Schema.optionalKey(Schema.String),
  byteSize: Schema.optionalKey(Schema.Number),
  remoteUrl: Schema.optionalKey(Schema.String),
  localPath: Schema.optionalKey(Schema.String),
});
export type ChannelAttachment = typeof ChannelAttachment.Type;

export const ChannelConversation = Schema.Struct({
  accountId: ChannelAccountId,
  conversationId: ChannelConversationId,
  service: ChatService,
  title: Schema.String,
  kind: Schema.Literals(["direct", "group", "channel", "thread"]),
  participants: Schema.Array(ChannelParticipant),
  containerId: Schema.optionalKey(Schema.String),
  containerTitle: Schema.optionalKey(Schema.String),
  containerAvatarUrl: Schema.optionalKey(Schema.String),
  position: Schema.optionalKey(Schema.Number),
  latestMessageAt: Schema.optionalKey(Schema.String),
  unreadCount: Schema.optionalKey(Schema.Number),
  completeness: ChannelDataCompleteness,
});
export type ChannelConversation = typeof ChannelConversation.Type;

export const ChannelMessage = Schema.Struct({
  accountId: ChannelAccountId,
  conversationId: ChannelConversationId,
  messageId: ChannelMessageId,
  service: ChatService,
  sender: ChannelParticipant,
  text: Schema.String,
  sentAt: Schema.String,
  editedAt: Schema.optionalKey(Schema.String),
  deletedAt: Schema.optionalKey(Schema.String),
  replyToMessageId: Schema.optionalKey(ChannelMessageId),
  threadId: Schema.optionalKey(Schema.String),
  attachments: Schema.Array(ChannelAttachment),
  rawPermalink: Schema.optionalKey(Schema.String),
});
export type ChannelMessage = typeof ChannelMessage.Type;

export const ChannelCloudSyncPolicy = Schema.Literals([
  "local_only",
  "metadata_only",
  "mirror_content",
]);
export type ChannelCloudSyncPolicy = typeof ChannelCloudSyncPolicy.Type;

export const ChannelSendMessageInput = Schema.Struct({
  accountId: ChannelAccountId,
  conversationId: ChannelConversationId,
  text: Schema.String,
  replyToMessageId: Schema.optionalKey(ChannelMessageId),
  attachmentPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  idempotencyKey: Schema.String,
});
export type ChannelSendMessageInput = typeof ChannelSendMessageInput.Type;

export const ChannelSendMessageResult = Schema.Struct({
  message: ChannelMessage,
  transport: ChannelTransportKind,
});
export type ChannelSendMessageResult = typeof ChannelSendMessageResult.Type;

export const ChannelListAccountsResult = Schema.Struct({
  accounts: Schema.Array(ConnectedChannelAccount),
});
export type ChannelListAccountsResult = typeof ChannelListAccountsResult.Type;

export const ChannelListConversationsInput = Schema.Struct({
  accountId: Schema.optionalKey(ChannelAccountId),
});
export type ChannelListConversationsInput = typeof ChannelListConversationsInput.Type;

export const ChannelListConversationsResult = Schema.Struct({
  conversations: Schema.Array(ChannelConversation),
});
export type ChannelListConversationsResult = typeof ChannelListConversationsResult.Type;

export const ChannelListMessagesInput = Schema.Struct({
  accountId: ChannelAccountId,
  conversationId: ChannelConversationId,
  limit: Schema.optionalKey(Schema.Number),
});
export type ChannelListMessagesInput = typeof ChannelListMessagesInput.Type;

export const ChannelListMessagesResult = Schema.Struct({
  messages: Schema.Array(ChannelMessage),
});
export type ChannelListMessagesResult = typeof ChannelListMessagesResult.Type;

export class ChannelOperationError extends Schema.TaggedErrorClass<ChannelOperationError>()(
  "ChannelOperationError",
  {
    accountId: Schema.optionalKey(ChannelAccountId),
    operation: Schema.optionalKey(ChannelOperation),
    kind: Schema.Literals([
      "account_not_found",
      "capability_unavailable",
      "permission_required",
      "setup_required",
      "transport_failed",
      "invalid_response",
    ]),
    message: Schema.String,
  },
) {}
