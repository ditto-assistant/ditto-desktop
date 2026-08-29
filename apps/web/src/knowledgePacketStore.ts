import type {
  ChannelAccountId,
  ChannelConversationId,
  ChannelKnowledgePacketRequest,
  ChatService,
} from "@t3tools/contracts";
import { create } from "zustand";

export interface PendingKnowledgePacket extends ChannelKnowledgePacketRequest {
  readonly label: string;
  readonly source: ChatService;
}

interface KnowledgePacketState {
  readonly pending: PendingKnowledgePacket | null;
  readonly attach: (packet: PendingKnowledgePacket) => void;
  readonly clear: () => void;
}

export const useKnowledgePacketStore = create<KnowledgePacketState>((set) => ({
  pending: null,
  attach: (pending) => set({ pending }),
  clear: () => set({ pending: null }),
}));

export function pendingKnowledgePacket(input: {
  readonly accountId: ChannelAccountId;
  readonly conversationId: ChannelConversationId;
  readonly label: string;
  readonly source: ChatService;
  readonly messageLimit?: number;
}): PendingKnowledgePacket {
  return {
    accountId: input.accountId,
    conversationId: input.conversationId,
    messageLimit: input.messageLimit ?? 50,
    label: input.label,
    source: input.source,
  };
}

export function knowledgePacketBootstrap(packet: PendingKnowledgePacket, destinationCwd: string) {
  return {
    knowledgePackets: [
      {
        accountId: packet.accountId,
        conversationId: packet.conversationId,
        messageLimit: packet.messageLimit,
      },
    ],
    knowledgePacketCwd: destinationCwd,
  } as const;
}
