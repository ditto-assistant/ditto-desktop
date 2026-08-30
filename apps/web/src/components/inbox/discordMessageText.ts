import type { ChannelResolvedMention } from "@t3tools/contracts";

const CODE_SEGMENT_PATTERN = /(```[\s\S]*?```|`[^`\n]+`)/g;
const MENTION_PATTERN = /<(@!?|#|@&)(\d+)>/g;

function escapeMarkdownLabel(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&");
}

export function resolveDiscordMessageText(
  text: string,
  mentions: ReadonlyArray<ChannelResolvedMention> | undefined,
): string {
  if (mentions === undefined || mentions.length === 0) return text;
  const byKey = new Map(mentions.map((mention) => [`${mention.kind}:${mention.id}`, mention]));
  return text
    .split(CODE_SEGMENT_PATTERN)
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment.replace(MENTION_PATTERN, (token, prefix: string, id: string) => {
        const kind = prefix === "#" ? "channel" : prefix === "@&" ? "role" : "user";
        const mention = byKey.get(`${kind}:${id}`);
        if (mention === undefined) return token;
        const sigil = kind === "channel" ? "#" : "@";
        return `${sigil}${escapeMarkdownLabel(mention.displayName)}`;
      });
    })
    .join("");
}
