import { describe, expect, it } from "vite-plus/test";
import { ChannelAccountId, ChannelConversationId } from "@t3tools/contracts";

import {
  knowledgePacketBootstrap,
  pendingKnowledgePacket,
  useKnowledgePacketStore,
} from "./knowledgePacketStore";

describe("knowledgePacketStore", () => {
  it("keeps only source identifiers and a bounded range, never private message content", () => {
    const packet = pendingKnowledgePacket({
      accountId: ChannelAccountId.make("discord:local"),
      conversationId: ChannelConversationId.make("liam-dm"),
      label: "Liam",
      source: "discord",
    });
    useKnowledgePacketStore.getState().attach(packet);

    expect(useKnowledgePacketStore.getState().pending).toEqual([
      {
        accountId: "discord:local",
        conversationId: "liam-dm",
        label: "Liam",
        source: "discord",
        messageLimit: 50,
      },
    ]);
    expect(JSON.stringify(useKnowledgePacketStore.getState().pending)).not.toContain("messageText");
    useKnowledgePacketStore.getState().clear();
    expect(useKnowledgePacketStore.getState().pending).toEqual([]);
  });

  it("attaches multiple chats, deduplicates them, and removes one independently", () => {
    const liam = pendingKnowledgePacket({
      accountId: ChannelAccountId.make("discord:local"),
      conversationId: ChannelConversationId.make("liam-dm"),
      label: "Liam",
      source: "discord",
    });
    const omar = pendingKnowledgePacket({
      accountId: ChannelAccountId.make("discord:local"),
      conversationId: ChannelConversationId.make("omar-dm"),
      label: "Omar",
      source: "discord",
    });
    useKnowledgePacketStore.getState().attach(liam);
    useKnowledgePacketStore.getState().attach(omar);
    useKnowledgePacketStore.getState().attach({ ...liam, messageLimit: 75 });

    expect(useKnowledgePacketStore.getState().pending.map((packet) => packet.label)).toEqual([
      "Omar",
      "Liam",
    ]);
    expect(useKnowledgePacketStore.getState().pending[1]?.messageLimit).toBe(75);
    useKnowledgePacketStore.getState().detach(omar.accountId, omar.conversationId);
    expect(useKnowledgePacketStore.getState().pending.map((packet) => packet.label)).toEqual([
      "Liam",
    ]);
    useKnowledgePacketStore.getState().clear();
  });

  it("builds a bootstrap descriptor without embedding chat content", () => {
    const packet = pendingKnowledgePacket({
      accountId: ChannelAccountId.make("discord:local"),
      conversationId: ChannelConversationId.make("liam-dm"),
      label: "Liam",
      source: "discord",
      messageLimit: 25,
    });
    expect(knowledgePacketBootstrap([packet], "/worktrees/task")).toEqual({
      knowledgePackets: [
        { accountId: "discord:local", conversationId: "liam-dm", messageLimit: 25 },
      ],
      knowledgePacketCwd: "/worktrees/task",
    });
  });
});
