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

    expect(useKnowledgePacketStore.getState().pending).toEqual({
      accountId: "discord:local",
      conversationId: "liam-dm",
      label: "Liam",
      source: "discord",
      messageLimit: 50,
    });
    expect(JSON.stringify(useKnowledgePacketStore.getState().pending)).not.toContain("messageText");
    useKnowledgePacketStore.getState().clear();
    expect(useKnowledgePacketStore.getState().pending).toBeNull();
  });

  it("builds a bootstrap descriptor without embedding chat content", () => {
    const packet = pendingKnowledgePacket({
      accountId: ChannelAccountId.make("discord:local"),
      conversationId: ChannelConversationId.make("liam-dm"),
      label: "Liam",
      source: "discord",
      messageLimit: 25,
    });
    expect(knowledgePacketBootstrap(packet, "/worktrees/task")).toEqual({
      knowledgePackets: [
        { accountId: "discord:local", conversationId: "liam-dm", messageLimit: 25 },
      ],
      knowledgePacketCwd: "/worktrees/task",
    });
  });
});
