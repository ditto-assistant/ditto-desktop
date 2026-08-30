import {
  ChannelConversation,
  ChannelMessage,
  ChannelOperationError,
  ChannelSendMessageResult,
  ConnectedChannelAccount,
  type ChannelSendMessageInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Duration from "effect/Duration";

import type { ChannelCommandRun } from "./ChannelAdapter.ts";
import { TELEGRAM_LOCAL_ACCOUNT_ID, type TelegramChannelSource } from "./TelegramAdapter.ts";

const HelperStatus = Schema.Struct({
  available: Schema.Boolean,
  installed: Schema.Boolean,
  permission: Schema.Literals(["granted", "not_granted", "unavailable"]),
  client: Schema.Literals(["telegram-desktop", "telegram-macos", "none"]),
  detail: Schema.String,
});

const HelperSnapshot = Schema.Struct({
  ...HelperStatus.fields,
  conversations: Schema.Array(ChannelConversation),
  messages: Schema.Record(Schema.String, Schema.Array(ChannelMessage)),
});

const HelperSend = Schema.Struct({
  sent: Schema.Boolean,
  detail: Schema.String,
  message: Schema.optionalKey(ChannelMessage),
});

type HelperStatus = typeof HelperStatus.Type;
type HelperSnapshot = typeof HelperSnapshot.Type;
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const capabilities = (status: HelperStatus) => {
  const readable = status.available && status.permission === "granted";
  const sendable = readable && status.client === "telegram-desktop";
  const readAvailability = readable
    ? ("available" as const)
    : status.permission !== "granted"
      ? ("permission_required" as const)
      : ("setup_required" as const);
  return [
    {
      operation: "history.read" as const,
      availability: readAvailability,
      ...(!readable
        ? {
            reason: status.detail,
            setupAction:
              "Allow Ditto's Telegram helper in System Settings → Privacy & Security → Accessibility.",
          }
        : {}),
    },
    {
      operation: "events.live" as const,
      availability: readAvailability,
      ...(!readable ? { reason: status.detail } : {}),
    },
    {
      operation: "message.send" as const,
      availability: sendable ? ("available" as const) : ("unsupported" as const),
      ...(!sendable
        ? {
            reason:
              "The native Telegram for macOS client does not expose enough Accessibility metadata to verify a destination before sending.",
          }
        : {}),
    },
    { operation: "message.reply" as const, availability: "unsupported" as const },
    { operation: "attachment.read" as const, availability: "unsupported" as const },
    { operation: "attachment.write" as const, availability: "unsupported" as const },
    { operation: "reaction.read" as const, availability: "unsupported" as const },
    { operation: "reaction.write" as const, availability: "unsupported" as const },
    { operation: "thread.read" as const, availability: "unsupported" as const },
    { operation: "thread.write" as const, availability: "unsupported" as const },
    { operation: "message.edit" as const, availability: "unsupported" as const },
    { operation: "message.delete" as const, availability: "unsupported" as const },
    { operation: "mention.write" as const, availability: "unsupported" as const },
    { operation: "typing.write" as const, availability: "unsupported" as const },
    { operation: "read_state.write" as const, availability: "unsupported" as const },
    { operation: "poll.read" as const, availability: "unsupported" as const },
    { operation: "poll.write" as const, availability: "unsupported" as const },
    { operation: "voice_note.read" as const, availability: "unsupported" as const },
    { operation: "voice_note.write" as const, availability: "unsupported" as const },
    { operation: "call.read" as const, availability: "unsupported" as const },
    { operation: "call.start" as const, availability: "unsupported" as const },
  ];
};

function operationError(
  kind: ChannelOperationError["kind"],
  message: string,
): ChannelOperationError {
  return new ChannelOperationError({
    accountId: TELEGRAM_LOCAL_ACCOUNT_ID,
    kind,
    message,
  });
}

export interface TelegramLocalSourceOptions {
  readonly platform: NodeJS.Platform;
  readonly helperPath: string | undefined;
  readonly run: ChannelCommandRun;
  readonly nowIso?: () => string;
}

export function makeTelegramLocalSource(
  options: TelegramLocalSourceOptions,
): TelegramChannelSource {
  let lastSnapshot: HelperSnapshot | undefined;
  // ProcessRunner does not expose stdin. Commands are passed as one bounded,
  // base64url JSON argument so message text is never interpreted by a shell.
  const command = <A>(
    payload: unknown,
    schema: Schema.Decoder<A, never>,
    timeout: Duration.Input = "8 seconds",
  ) => {
    const encodedPayload = Buffer.from(encodeUnknownJson(payload)).toString("base64url");
    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(schema));
    return Effect.suspend(() =>
      options.helperPath === undefined
        ? Effect.fail(operationError("setup_required", "Telegram helper is not bundled."))
        : options
            .run({
              command: options.helperPath,
              args: [encodedPayload],
              timeout,
            })
            .pipe(
              Effect.flatMap((output) =>
                output.code === 0
                  ? decodeOutput(output.stdout).pipe(
                      Effect.mapError((cause) => operationError("invalid_response", String(cause))),
                    )
                  : Effect.fail(
                      operationError(
                        "transport_failed",
                        output.stderr.trim() || `Telegram helper exited ${String(output.code)}.`,
                      ),
                    ),
              ),
            ),
    );
  };

  const status = (prompt = false) =>
    command({ command: "status", prompt }, HelperStatus).pipe(
      Effect.orElseSucceed(() => ({
        available: false,
        installed: false,
        permission: "unavailable" as const,
        client: "none" as const,
        detail:
          options.platform === "darwin"
            ? "Telegram helper is unavailable in this build."
            : "Local Telegram bridging is available on macOS only.",
      })),
    );

  const snapshot = command({ command: "snapshot" }, HelperSnapshot, "15 seconds").pipe(
    Effect.tap((value) => Effect.sync(() => (lastSnapshot = value))),
  );

  const toAccount = (value: HelperStatus): ConnectedChannelAccount => ({
    accountId: TELEGRAM_LOCAL_ACCOUNT_ID,
    service: "telegram",
    transport: "telegram-desktop-local",
    executionLocation: "device",
    identityMode: "user",
    label: "Telegram on this Mac",
    enabled: true,
    state: !value.installed
      ? "unavailable"
      : value.permission !== "granted"
        ? "permission_required"
        : !value.available
          ? "setup_required"
          : "ready",
    capabilities: [...capabilities(value)],
    completeness: "device_cache_partial",
    ...(options.nowIso ? { lastObservedAt: options.nowIso() } : {}),
    statusDetail: value.detail,
  });

  return {
    configure: (enabled) =>
      enabled
        ? status(true).pipe(Effect.map(toAccount))
        : Effect.fail(
            operationError("capability_unavailable", "Local Telegram discovery is automatic."),
          ),
    discover: status().pipe(Effect.map(toAccount)),
    listConversations: snapshot.pipe(Effect.map((value) => value.conversations)),
    listMessages: (conversationId, limit = 150) =>
      snapshot.pipe(
        Effect.map((value) =>
          (value.messages[conversationId] ?? []).slice(-Math.max(1, Math.min(limit, 500))),
        ),
      ),
    sendMessage: (input) =>
      command(
        {
          command: "send",
          conversationId: input.conversationId,
          conversationTitle: lastSnapshot?.conversations.find(
            (conversation) => conversation.conversationId === input.conversationId,
          )?.title,
          text: input.text,
          idempotencyKey: input.idempotencyKey,
        },
        HelperSend,
        "12 seconds",
      ).pipe(
        Effect.flatMap((result) => {
          if (!result.sent || result.message === undefined) {
            return Effect.fail(operationError("transport_failed", result.detail));
          }
          return Effect.succeed({
            message: result.message,
            transport: "telegram-desktop-local" as const,
          } satisfies ChannelSendMessageResult);
        }),
      ),
  };
}
