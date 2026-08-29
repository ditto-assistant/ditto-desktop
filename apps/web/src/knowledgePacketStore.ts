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
  readonly pending: ReadonlyArray<PendingKnowledgePacket>;
  readonly attach: (packet: PendingKnowledgePacket) => void;
  readonly detach: (accountId: ChannelAccountId, conversationId: ChannelConversationId) => void;
  readonly clear: () => void;
}

export const useKnowledgePacketStore = create<KnowledgePacketState>((set) => ({
  pending: [],
  attach: (packet) =>
    set((state) => ({
      pending: [
        ...state.pending.filter(
          (candidate) =>
            candidate.accountId !== packet.accountId ||
            candidate.conversationId !== packet.conversationId,
        ),
        packet,
      ].slice(-8),
    })),
  detach: (accountId, conversationId) =>
    set((state) => ({
      pending: state.pending.filter(
        (candidate) =>
          candidate.accountId !== accountId || candidate.conversationId !== conversationId,
      ),
    })),
  clear: () => set({ pending: [] }),
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

export function knowledgePacketBootstrap(
  packets: ReadonlyArray<PendingKnowledgePacket>,
  destinationCwd: string,
) {
  return {
    knowledgePackets: packets.map((packet) => ({
      accountId: packet.accountId,
      conversationId: packet.conversationId,
      messageLimit: packet.messageLimit,
    })),
    knowledgePacketCwd: destinationCwd,
  } as const;
}
