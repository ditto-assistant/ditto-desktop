import {
  ChannelAccountId,
  ChannelConversationId,
  ChannelOperationError,
  type ChannelConversation,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ChannelAdapter } from "./ChannelAdapter.ts";
import { makeChannelRegistry } from "./ChannelRegistry.ts";

const discordAccountId = ChannelAccountId.make("discord:local");
const messagesAccountId = ChannelAccountId.make("imessage:local");
const discordConversation = {
  accountId: discordAccountId,
  conversationId: ChannelConversationId.make("liam-dm"),
  service: "discord",
  title: "Liam",
  kind: "direct",
  participants: [],
  completeness: "device_cache_partial",
} satisfies ChannelConversation;

function adapter(listConversations: ChannelAdapter["listConversations"]): ChannelAdapter {
  return {
    discover: Effect.die("not used"),
    listConversations,
    listMessages: () => Effect.die("not used"),
    sendMessage: () => Effect.die("not used"),
  };
}

it.effect(
  "keeps healthy conversations in aggregate search when another adapter is unavailable",
  () =>
    Effect.gen(function* () {
      const registry = makeChannelRegistry(
        new Map([
          [discordAccountId, adapter(Effect.succeed([discordConversation]))],
          [
            messagesAccountId,
            adapter(
              Effect.fail(
                new ChannelOperationError({
                  accountId: messagesAccountId,
                  kind: "permission_required",
                  message: "Full Disk Access is required.",
                }),
              ),
            ),
          ],
        ]),
      );

      expect(yield* registry.listConversations()).toEqual([discordConversation]);
      expect(yield* Effect.exit(registry.listConversations(messagesAccountId))).toMatchObject({
        _tag: "Failure",
      });
    }),
);
