import type {
  ChannelConversation,
  ChannelMessage,
  ConnectedChannelAccount,
  DiscordAccessibilitySnapshotResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { mergeDiscordLiveSnapshot } from "./discordLiveMessages";

const account = {
  accountId: "discord-local",
  service: "discord",
} as ConnectedChannelAccount;
const conversation = {
  accountId: account.accountId,
  conversationId: "1531175553309343915",
  service: "discord",
  title: "Trupan",
} as ChannelConversation;
const archived = [
  {
    accountId: account.accountId,
    conversationId: conversation.conversationId,
    messageId: "1534837592586063954",
    service: "discord",
    sender: { id: "1", displayName: "Trupan" },
    text: "archive tail",
    sentAt: "2026-08-29T04:55:00.000Z",
    attachments: [],
  } as unknown as ChannelMessage,
];

function snapshot(messages: DiscordAccessibilitySnapshotResult["messages"]) {
  return {
    accountId: account.accountId,
    conversationId: conversation.conversationId,
    permission: "granted",
    observedAt: "2026-08-29T06:09:00.000Z",
    targetVerified: true,
    truncated: false,
    detail: "verified",
    messages,
  } as DiscordAccessibilitySnapshotResult;
}

describe("mergeDiscordLiveSnapshot", () => {
  it("keeps Discrawl history and appends the newer verified AX tail", () => {
    const result = mergeDiscordLiveSnapshot(
      archived,
      account,
      conversation,
      snapshot([
        {
          id: "1534850000000000000",
          author: "Trupan",
          timestamp: "Today at 2:08 AM",
          sentAt: "2026-08-29T06:08:00.000Z",
          content: "live tail",
          attachments: [
            { indicator: "image.png", url: "https://cdn.discordapp.com/attachments/1/2/image.png" },
          ],
          provenance: "discord_accessibility_live",
        },
      ]),
    );
    expect(result.map((message) => message.text)).toEqual(["archive tail", "live tail"]);
    expect(result[1]?.attachments[0]?.filename).toBe("image.png");
  });

  it("deduplicates a Discord snowflake already present in the archive", () => {
    const result = mergeDiscordLiveSnapshot(
      archived,
      account,
      conversation,
      snapshot([
        {
          id: "1534837592586063954",
          author: "Trupan",
          sentAt: "2026-08-29T04:55:00.000Z",
          content: "archive tail",
          attachments: [],
          provenance: "discord_accessibility_live",
        },
      ]),
    );
    expect(result).toHaveLength(1);
  });

  it("ignores an AX snapshot that did not verify the selected target", () => {
    const unverified = { ...snapshot([]), targetVerified: false };
    expect(mergeDiscordLiveSnapshot(archived, account, conversation, unverified)).toBe(archived);
  });
});
