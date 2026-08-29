import { describe, expect, it } from "vite-plus/test";
import {
  ChannelAccountId,
  ChannelConversationId,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";

import {
  knowledgePacketBootstrap,
  knowledgePacketTargetKey,
  pendingKnowledgePacket,
  useKnowledgePacketStore,
} from "./knowledgePacketStore";

describe("knowledgePacketStore", () => {
  const environmentId = EnvironmentId.make("local");
  const draftTarget = knowledgePacketTargetKey(environmentId, "draft-a");

  it("keeps only source identifiers and a bounded range, never private message content", () => {
    const packet = pendingKnowledgePacket({
      accountId: ChannelAccountId.make("discord:local"),
      conversationId: ChannelConversationId.make("liam-dm"),
      label: "Liam",
      source: "discord",
    });
    useKnowledgePacketStore.getState().attach(draftTarget, packet);

    expect(useKnowledgePacketStore.getState().pendingByTarget[draftTarget]).toEqual([
      {
        accountId: "discord:local",
        conversationId: "liam-dm",
        label: "Liam",
        source: "discord",
        messageLimit: 50,
      },
    ]);
    expect(JSON.stringify(useKnowledgePacketStore.getState().pendingByTarget)).not.toContain(
      "messageText",
    );
    useKnowledgePacketStore.getState().clear(draftTarget);
    expect(useKnowledgePacketStore.getState().pendingByTarget[draftTarget]).toBeUndefined();
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
    useKnowledgePacketStore.getState().attach(draftTarget, liam);
    useKnowledgePacketStore.getState().attach(draftTarget, omar);
    useKnowledgePacketStore.getState().attach(draftTarget, { ...liam, messageLimit: 75 });

    expect(
      useKnowledgePacketStore
        .getState()
        .pendingByTarget[draftTarget]?.map((packet) => packet.label),
    ).toEqual(["Omar", "Liam"]);
    expect(useKnowledgePacketStore.getState().pendingByTarget[draftTarget]?.[1]?.messageLimit).toBe(
      75,
    );
    useKnowledgePacketStore.getState().detach(draftTarget, omar.accountId, omar.conversationId);
    expect(
      useKnowledgePacketStore
        .getState()
        .pendingByTarget[draftTarget]?.map((packet) => packet.label),
    ).toEqual(["Liam"]);
    useKnowledgePacketStore.getState().clear(draftTarget);
  });

  it("isolates attached chats between drafts and scoped server threads", () => {
    const otherDraft = knowledgePacketTargetKey(environmentId, "draft-b");
    const serverThread = knowledgePacketTargetKey(environmentId, {
      environmentId,
      threadId: ThreadId.make("thread-a"),
    });
    const packet = pendingKnowledgePacket({
      accountId: ChannelAccountId.make("discord:local"),
      conversationId: ChannelConversationId.make("liam-dm"),
      label: "Liam",
      source: "discord",
    });

    useKnowledgePacketStore.getState().attach(draftTarget, packet);

    expect(useKnowledgePacketStore.getState().pendingByTarget[draftTarget]).toHaveLength(1);
    expect(useKnowledgePacketStore.getState().pendingByTarget[otherDraft]).toBeUndefined();
    expect(useKnowledgePacketStore.getState().pendingByTarget[serverThread]).toBeUndefined();
    useKnowledgePacketStore.getState().clear(draftTarget);
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
