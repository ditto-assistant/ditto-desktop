import {
  ChannelAccountId,
  ChannelOperationError,
  type ChannelConversation,
  type ChannelMessage,
  type ChannelSendMessageInput,
  type ChannelSendMessageResult,
  type ConnectedChannelAccount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ChannelAdapter } from "./ChannelAdapter.ts";

export const TELEGRAM_LOCAL_ACCOUNT_ID = ChannelAccountId.make("telegram:desktop:local");

/**
 * The inbox consumes this source contract, not Telegram Desktop storage directly.
 * A signed-in desktop can therefore select a Ditto Cloud implementation later
 * without changing conversation routes or rendering two copies of each chat.
 */
export interface TelegramChannelSource {
  readonly configure?: (
    enabled: boolean,
  ) => Effect.Effect<ConnectedChannelAccount, ChannelOperationError>;
  readonly discover: Effect.Effect<ConnectedChannelAccount, ChannelOperationError>;
  readonly listConversations: Effect.Effect<
    ReadonlyArray<ChannelConversation>,
    ChannelOperationError
  >;
  readonly listMessages: (
    conversationId: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<ChannelMessage>, ChannelOperationError>;
  readonly sendMessage: (
    input: ChannelSendMessageInput,
  ) => Effect.Effect<ChannelSendMessageResult, ChannelOperationError>;
}

export type TelegramSourceMode = "local" | "cloud";

export interface TelegramSourceSelection {
  readonly mode: TelegramSourceMode;
  readonly source: TelegramChannelSource;
}

export function makeTelegramAdapter(selectSource: () => TelegramSourceSelection): ChannelAdapter {
  return {
    configure: (enabled) => {
      const source = selectSource().source;
      return source.configure === undefined
        ? Effect.fail(
            new ChannelOperationError({
              accountId: TELEGRAM_LOCAL_ACCOUNT_ID,
              kind: "capability_unavailable",
              message: "This Telegram source cannot be configured from the desktop.",
            }),
          )
        : source.configure(enabled);
    },
    discover: Effect.suspend(() => selectSource().source.discover),
    listConversations: Effect.suspend(() => selectSource().source.listConversations),
    listMessages: (conversationId, limit) =>
      Effect.suspend(() => selectSource().source.listMessages(conversationId, limit)),
    sendMessage: (input) => Effect.suspend(() => selectSource().source.sendMessage(input)),
  };
}
