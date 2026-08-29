import type {
  DiscordAccessibilityReplyInput,
  DiscordAccessibilitySnapshotInput,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  DiscordAccessibilityTransport,
  type DiscordAccessibilityHelperRunner,
} from "./DiscordAccessibilityTransport.ts";

const input = {
  actionId: "reply-action-123",
  origin: "local_desktop",
  requestedAt: "2026-08-29T12:00:00.000Z",
  accountId: "discord-local",
  conversationId: "1531175553309343915",
  containerId: "1073292100218654821",
  conversationTitle: "general",
  text: "hello from Ditto",
  mode: "send",
} as DiscordAccessibilityReplyInput;

describe("DiscordAccessibilityTransport", () => {
  const snapshotInput = {
    accountId: input.accountId,
    conversationId: input.conversationId,
    conversationTitle: "Trupan",
    maxMessages: 50,
  } as DiscordAccessibilitySnapshotInput;

  it("validates a Discord target before invoking the native helper", async () => {
    let calls = 0;
    const runner: DiscordAccessibilityHelperRunner = {
      run: async () => {
        calls += 1;
        return {};
      },
    };
    const transport = new DiscordAccessibilityTransport("darwin", runner);
    const result = await transport.execute({ ...input, conversationId: "../../settings" } as never);
    assert.equal(result.outcome, "failed");
    assert.equal(calls, 0);
  });

  it("forwards only the validated deep link and returns an audited receipt", async () => {
    let deepLink = "";
    const runner: DiscordAccessibilityHelperRunner = {
      run: async (command) => {
        if (command.command !== "execute") throw new Error("unexpected command");
        deepLink = command.deepLink;
        return {
          actionId: input.actionId,
          origin: input.origin,
          mode: input.mode,
          outcome: "sent",
          permission: "granted",
          startedAt: "2026-08-29T12:00:01.000Z",
          completedAt: "2026-08-29T12:00:02.000Z",
          detail: "Sent after Discord cleared the verified composer.",
          sent: true,
          draftPrepared: false,
          duplicate: false,
        };
      },
    };
    const result = await new DiscordAccessibilityTransport("darwin", runner).execute(input);
    assert.equal(deepLink, "discord://-/channels/1073292100218654821/1531175553309343915");
    assert.isTrue(result.sent);
  });

  it("deduplicates a completed explicit action id", async () => {
    let calls = 0;
    const runner: DiscordAccessibilityHelperRunner = {
      run: async () => {
        calls += 1;
        return {
          actionId: input.actionId,
          origin: input.origin,
          mode: input.mode,
          outcome: "draft_prepared",
          permission: "granted",
          startedAt: "2026-08-29T12:00:01.000Z",
          completedAt: "2026-08-29T12:00:02.000Z",
          detail: "Draft prepared.",
          sent: false,
          draftPrepared: true,
          duplicate: false,
        };
      },
    };
    const transport = new DiscordAccessibilityTransport("darwin", runner);
    await transport.execute(input);
    const duplicate = await transport.execute(input);
    assert.equal(calls, 1);
    assert.isTrue(duplicate.duplicate);
  });

  it("does not expose the transport on non-macOS hosts", async () => {
    const runner: DiscordAccessibilityHelperRunner = { run: async () => ({}) };
    const result = await new DiscordAccessibilityTransport("linux", runner).execute(input);
    assert.equal(result.outcome, "unsupported");
  });

  it("reads a bounded snapshot without a deep link or reply text", async () => {
    let received: unknown;
    const runner: DiscordAccessibilityHelperRunner = {
      run: async (command) => {
        received = command;
        return {
          accountId: snapshotInput.accountId,
          conversationId: snapshotInput.conversationId,
          permission: "granted",
          observedAt: "2026-08-29T06:09:00.000Z",
          targetVerified: true,
          truncated: false,
          detail: "Read one message.",
          messages: [
            {
              id: "1534850000000000000",
              author: "Trupan",
              timestamp: "Today at 2:08 AM",
              sentAt: "2026-08-29T06:08:00.000Z",
              content: "fresh",
              attachments: [],
              provenance: "discord_accessibility_live",
            },
          ],
        };
      },
    };
    const result = await new DiscordAccessibilityTransport("darwin", runner).snapshot(
      snapshotInput,
    );
    assert.deepEqual(received, {
      command: "snapshot",
      accountId: snapshotInput.accountId,
      conversationId: snapshotInput.conversationId,
      expectedTitle: "Trupan",
      maxMessages: 50,
    });
    assert.equal(result.messages[0]?.content, "fresh");
  });

  it("rejects an invalid snapshot target before invoking the helper", async () => {
    let calls = 0;
    const runner: DiscordAccessibilityHelperRunner = {
      run: async () => {
        calls += 1;
        return {};
      },
    };
    const result = await new DiscordAccessibilityTransport("darwin", runner).snapshot({
      ...snapshotInput,
      conversationId: "../../settings",
    } as never);
    assert.isFalse(result.targetVerified);
    assert.equal(calls, 0);
  });
});
