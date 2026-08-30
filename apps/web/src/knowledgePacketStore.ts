import type {
  ChannelAccountId,
  ChannelConversationId,
  ChannelKnowledgePacketRequest,
  ChatService,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

export interface PendingKnowledgePacket extends ChannelKnowledgePacketRequest {
  readonly label: string;
  readonly source: ChatService;
}

interface KnowledgePacketState {
  readonly pendingByTarget: Readonly<Record<string, ReadonlyArray<PendingKnowledgePacket>>>;
  readonly activeTargetByEnvironment: Readonly<Record<string, string>>;
  readonly attach: (targetKey: string, packet: PendingKnowledgePacket) => void;
  readonly detach: (
    targetKey: string,
    accountId: ChannelAccountId,
    conversationId: ChannelConversationId,
  ) => void;
  readonly clear: (targetKey: string) => void;
  readonly setActiveTarget: (environmentId: EnvironmentId, targetKey: string) => void;
}

export const useKnowledgePacketStore = create<KnowledgePacketState>((set) => ({
  pendingByTarget: {},
  activeTargetByEnvironment: {},
  attach: (targetKey, packet) =>
    set((state) => ({
      pendingByTarget: {
        ...state.pendingByTarget,
        [targetKey]: [
          ...(state.pendingByTarget[targetKey] ?? []).filter(
            (candidate) =>
              candidate.accountId !== packet.accountId ||
              candidate.conversationId !== packet.conversationId,
          ),
          packet,
        ].slice(-8),
      },
    })),
  detach: (targetKey, accountId, conversationId) =>
    set((state) => ({
      pendingByTarget: {
        ...state.pendingByTarget,
        [targetKey]: (state.pendingByTarget[targetKey] ?? []).filter(
          (candidate) =>
            candidate.accountId !== accountId || candidate.conversationId !== conversationId,
        ),
      },
    })),
  clear: (targetKey) =>
    set((state) => {
      const { [targetKey]: _, ...remaining } = state.pendingByTarget;
      return { pendingByTarget: remaining };
    }),
  setActiveTarget: (environmentId, targetKey) =>
    set((state) => ({
      activeTargetByEnvironment: {
        ...state.activeTargetByEnvironment,
        [environmentId]: targetKey,
      },
    })),
}));

export function knowledgePacketTargetKey(
  environmentId: EnvironmentId,
  target: ScopedThreadRef | string,
): string {
  return typeof target === "string"
    ? `draft:${environmentId}:${target.trim()}`
    : `thread:${scopedThreadKey(target)}`;
}

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
