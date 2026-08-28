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
import * as DateTime from "effect/DateTime";

import {
  type ChannelAdapter,
  type ChannelCommandRun,
  parseJsonRows,
  readString,
  unknownRecord,
} from "./ChannelAdapter.ts";

export const IMESSAGE_ACCOUNT_ID = ChannelAccountId.make("imessage:macos:local");

const APPLE_SCRIPT_SEND = `on run argv
  set targetHandle to item 1 of argv
  set messageText to item 2 of argv
  tell application "Messages"
    set targetService to first service whose service type = iMessage
    set targetBuddy to buddy targetHandle of targetService
    send messageText to targetBuddy
  end tell
end run`;

const READ_PERMISSION_ACTION =
  "Open System Settings → Privacy & Security → Full Disk Access and enable Ditto.";
const SEND_PERMISSION_ACTION =
  "Approve Ditto controlling Messages in System Settings → Privacy & Security → Automation.";

function capabilities(readReady: boolean): ReadonlyArray<ChannelCapability> {
  const readAvailability = readReady ? "available" : "permission_required";
  return [
    {
      operation: "history.read",
      availability: readAvailability,
      ...(!readReady
        ? {
            reason: "Messages history requires Full Disk Access.",
            setupAction: READ_PERMISSION_ACTION,
          }
        : {}),
    },
    { operation: "events.live", availability: "unsupported" },
    {
      operation: "message.send",
      availability: "permission_required",
      reason: "macOS asks before Ditto may control Messages.",
      setupAction: SEND_PERMISSION_ACTION,
    },
    {
      operation: "message.reply",
      availability: "permission_required",
      reason: "The initial adapter sends to a handle; native reply metadata is not yet supported.",
      setupAction: SEND_PERMISSION_ACTION,
    },
    { operation: "attachment.read", availability: readAvailability },
    { operation: "attachment.write", availability: "unsupported" },
    { operation: "reaction.read", availability: readAvailability },
    { operation: "reaction.write", availability: "unsupported" },
    { operation: "thread.read", availability: "unsupported" },
    { operation: "thread.write", availability: "unsupported" },
    { operation: "message.edit", availability: "unsupported" },
    { operation: "message.delete", availability: "unsupported" },
    { operation: "mention.write", availability: "unsupported" },
    { operation: "typing.write", availability: "unsupported" },
    { operation: "read_state.write", availability: "unsupported" },
    { operation: "poll.read", availability: "unsupported" },
    { operation: "poll.write", availability: "unsupported" },
    { operation: "voice_note.read", availability: readAvailability },
    { operation: "voice_note.write", availability: "unsupported" },
    { operation: "call.read", availability: "unsupported" },
    { operation: "call.start", availability: "unsupported" },
  ];
}

function operationError(
  kind: ChannelOperationError["kind"],
  message: string,
): ChannelOperationError {
  return new ChannelOperationError({ accountId: IMESSAGE_ACCOUNT_ID, kind, message });
}

function normalizeConversation(value: unknown): ChannelConversation | null {
  const row = unknownRecord(value);
  if (row === null) return null;
  const rowId = readString(row, "rowid", "ROWID", "id");
  if (rowId === undefined) return null;
  const handle = readString(row, "handle", "chat_identifier");
  const latestMessageAt = readString(row, "latest_message_at");
  return {
    accountId: IMESSAGE_ACCOUNT_ID,
    conversationId: ChannelConversationId.make(rowId),
    service: "imessage",
    title: readString(row, "display_name") ?? handle ?? `Conversation ${rowId}`,
    kind: row.style === 43 ? "group" : "direct",
    participants: handle ? [{ id: handle, displayName: handle, handle, isSelf: false }] : [],
    ...(latestMessageAt !== undefined ? { latestMessageAt } : {}),
    completeness: "complete",
  };
}

function normalizeMessage(value: unknown, conversationId: string): ChannelMessage | null {
  const row = unknownRecord(value);
  if (row === null) return null;
  const rowId = readString(row, "rowid", "ROWID", "id");
  if (rowId === undefined) return null;
  const fromSelf = row.is_from_me === 1 || row.is_from_me === true;
  const handle = readString(row, "handle") ?? (fromSelf ? "self" : "unknown");
  return {
    accountId: IMESSAGE_ACCOUNT_ID,
    conversationId: ChannelConversationId.make(conversationId),
    messageId: ChannelMessageId.make(rowId),
    service: "imessage",
    sender: {
      id: handle,
      displayName: fromSelf ? "You" : handle,
      ...(handle !== "self" ? { handle } : {}),
      isSelf: fromSelf,
    },
    text: readString(row, "text") ?? "",
    sentAt: readString(row, "sent_at") ?? "1970-01-01T00:00:00.000Z",
    attachments: [],
  };
}

export function makeIMessageAdapter(
  run: ChannelCommandRun,
  options: {
    readonly platform: NodeJS.Platform;
    readonly homeDirectory: string;
    readonly nowIso?: () => string;
  },
): ChannelAdapter {
  const platform = options.platform;
  const homeDirectory = options.homeDirectory;
  const databasePath = `${homeDirectory}/Library/Messages/chat.db`;

  const query = (sql: string) =>
    run({ command: "sqlite3", args: ["-json", databasePath, sql], timeout: "15 seconds" }).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              operationError(
                "permission_required",
                result.stderr.trim() || `Unable to read ${databasePath}. ${READ_PERMISSION_ACTION}`,
              ),
            ),
      ),
    );

  const unavailableAccount = (detail: string): ConnectedChannelAccount => ({
    accountId: IMESSAGE_ACCOUNT_ID,
    service: "imessage",
    transport: "imessage-macos",
    executionLocation: "device",
    identityMode: "user",
    label: "Messages on this Mac",
    state: platform === "darwin" ? "permission_required" : "unavailable",
    capabilities: [...capabilities(false)],
    completeness: "unknown",
    statusDetail: detail,
  });

  return {
    discover:
      platform !== "darwin"
        ? Effect.succeed(unavailableAccount("iMessage integration is available only on macOS."))
        : query("SELECT COUNT(*) AS chat_count FROM chat LIMIT 1").pipe(
            Effect.flatMap(() => DateTime.now),
            Effect.map(
              (observedAt): ConnectedChannelAccount => ({
                accountId: IMESSAGE_ACCOUNT_ID,
                service: "imessage",
                transport: "imessage-macos",
                executionLocation: "device",
                identityMode: "user",
                label: "Messages on this Mac",
                state: "ready",
                capabilities: [...capabilities(true)],
                completeness: "complete",
                lastObservedAt: DateTime.formatIso(observedAt),
              }),
            ),
            Effect.catch((error) => Effect.succeed(unavailableAccount(error.message))),
          ),
    listConversations:
      platform !== "darwin"
        ? Effect.fail(operationError("setup_required", "iMessage is available only on macOS."))
        : query(
            "SELECT c.ROWID AS rowid, c.display_name, c.chat_identifier, c.style, h.id AS handle, datetime(MAX(m.date)/1000000000 + 978307200, 'unixepoch') AS latest_message_at FROM chat c LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID LEFT JOIN handle h ON h.ROWID = chj.handle_id LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID LEFT JOIN message m ON m.ROWID = cmj.message_id GROUP BY c.ROWID ORDER BY MAX(m.date) DESC LIMIT 200",
          ).pipe(
            Effect.flatMap((stdout) =>
              Effect.try({
                try: () =>
                  parseJsonRows(stdout, ["rows", "data"])
                    .map(normalizeConversation)
                    .filter(
                      (conversation): conversation is ChannelConversation => conversation !== null,
                    ),
                catch: (cause) => operationError("invalid_response", String(cause)),
              }),
            ),
          ),
    listMessages: (conversationId, limit = 100) => {
      if (!/^\d+$/.test(conversationId)) {
        return Effect.fail(operationError("invalid_response", "Invalid Messages chat id."));
      }
      const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
      return query(
        `SELECT m.ROWID AS rowid, m.text, m.is_from_me, h.id AS handle, datetime(m.date/1000000000 + 978307200, 'unixepoch') AS sent_at FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE cmj.chat_id = ${conversationId} ORDER BY m.date DESC LIMIT ${safeLimit}`,
      ).pipe(
        Effect.flatMap((stdout) =>
          Effect.try({
            try: () =>
              parseJsonRows(stdout, ["messages", "rows", "data"])
                .map((row) => normalizeMessage(row, conversationId))
                .filter((message): message is ChannelMessage => message !== null)
                .reverse(),
            catch: (cause) => operationError("invalid_response", String(cause)),
          }),
        ),
      );
    },
    sendMessage: (input) => {
      const conversationId = String(input.conversationId);
      if (!conversationId.startsWith("handle:") || conversationId.length <= "handle:".length) {
        return Effect.fail(
          new ChannelOperationError({
            accountId: IMESSAGE_ACCOUNT_ID,
            operation: "message.send",
            kind: "capability_unavailable",
            message:
              "Initial iMessage sending requires a handle-addressed conversation id (handle:<phone-or-email>).",
          }),
        );
      }
      const targetHandle = conversationId.slice("handle:".length);
      const sentAt = options.nowIso
        ? Effect.succeed(options.nowIso())
        : DateTime.now.pipe(Effect.map(DateTime.formatIso));
      return run({
        command: "osascript",
        args: ["-e", APPLE_SCRIPT_SEND, "--", targetHandle, input.text],
        timeout: "30 seconds",
      }).pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? sentAt.pipe(
                Effect.map((sentAtValue) => ({
                  message: {
                    accountId: IMESSAGE_ACCOUNT_ID,
                    conversationId: input.conversationId,
                    messageId: ChannelMessageId.make(`local:${input.idempotencyKey}`),
                    service: "imessage" as const,
                    sender: { id: "self", displayName: "You", isSelf: true },
                    text: input.text,
                    sentAt: sentAtValue,
                    attachments: [],
                  },
                  transport: "imessage-macos" as const,
                })),
              )
            : Effect.fail(
                new ChannelOperationError({
                  accountId: IMESSAGE_ACCOUNT_ID,
                  operation: "message.send",
                  kind: "permission_required",
                  message: result.stderr.trim() || SEND_PERMISSION_ACTION,
                }),
              ),
        ),
      );
    },
  };
}
