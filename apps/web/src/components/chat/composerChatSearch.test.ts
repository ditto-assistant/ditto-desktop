import {
  ChannelAccountId,
  type ChannelConversation,
  ChannelConversationId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { searchComposerChats } from "./composerChatSearch";

const conversations = [
  {
    accountId: ChannelAccountId.make("discord:local"),
    conversationId: ChannelConversationId.make("liam-dm"),
    service: "discord",
    title: "Liam",
    kind: "direct",
    participants: [{ id: "liam", displayName: "Liam", handle: "@liam_dev" }],
    latestMessageAt: "2026-08-29T12:00:00.000Z",
    completeness: "device_cache_partial",
  },
  {
    accountId: ChannelAccountId.make("discord:local"),
    conversationId: ChannelConversationId.make("channel-1"),
    service: "discord",
    title: "liam-project",
    kind: "channel",
    participants: [],
    containerTitle: "Engineering",
    latestMessageAt: "2026-08-29T13:00:00.000Z",
    completeness: "device_cache_partial",
  },
  {
    accountId: ChannelAccountId.make("telegram:local"),
    conversationId: ChannelConversationId.make("omar-dm"),
    service: "telegram",
    title: "Omar Barazanji",
    kind: "direct",
    participants: [{ id: "omar", displayName: "Omar", handle: "@omarzanjiomni" }],
    latestMessageAt: "2026-08-29T11:00:00.000Z",
    completeness: "device_cache_partial",
  },
] satisfies ReadonlyArray<ChannelConversation>;

describe("searchComposerChats", () => {
  it("finds people by display name or handle and ranks direct chats first", () => {
    expect(searchComposerChats(conversations, "liam").map((chat) => chat.conversationId)).toEqual([
      "liam-dm",
      "channel-1",
    ]);
    expect(searchComposerChats(conversations, "omarzanji")[0]?.conversationId).toBe("omar-dm");
  });

  it("shows recent direct chats first for a bare at-sign", () => {
    expect(searchComposerChats(conversations, "").map((chat) => chat.conversationId)).toEqual([
      "liam-dm",
      "omar-dm",
      "channel-1",
    ]);
  });
});
