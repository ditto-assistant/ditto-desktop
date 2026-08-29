import type { ChannelConversation } from "@t3tools/contracts";

function searchableConversationText(conversation: ChannelConversation): string {
  return [
    conversation.title,
    conversation.containerTitle,
    ...conversation.participants.flatMap((participant) => [
      participant.displayName,
      participant.handle,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase();
}

function matchRank(conversation: ChannelConversation, query: string): number {
  if (query.length === 0) return 0;
  const title = conversation.title.toLocaleLowerCase();
  const participantNames = conversation.participants.flatMap((participant) => [
    participant.displayName.toLocaleLowerCase(),
    participant.handle?.replace(/^@/, "").toLocaleLowerCase() ?? "",
  ]);
  if (title === query || participantNames.includes(query)) return 0;
  if (title.startsWith(query) || participantNames.some((name) => name.startsWith(query))) return 1;
  if (searchableConversationText(conversation).includes(query)) return 2;
  return 3;
}

export function searchComposerChats(
  conversations: ReadonlyArray<ChannelConversation>,
  rawQuery: string,
  limit = 8,
): ReadonlyArray<ChannelConversation> {
  const query = rawQuery.trim().replace(/^@/, "").toLocaleLowerCase();
  return conversations
    .filter(
      (conversation) =>
        query.length === 0 || searchableConversationText(conversation).includes(query),
    )
    .sort((left, right) => {
      const rankDifference = matchRank(left, query) - matchRank(right, query);
      if (rankDifference !== 0) return rankDifference;
      if (left.kind === "direct" && right.kind !== "direct") return -1;
      if (right.kind === "direct" && left.kind !== "direct") return 1;
      return (right.latestMessageAt ?? "").localeCompare(left.latestMessageAt ?? "");
    })
    .slice(0, Math.max(0, limit));
}
