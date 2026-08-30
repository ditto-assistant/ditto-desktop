import { assert, describe, it } from "@effect/vitest";

import { appAutomationTargetKey } from "./AppScopedAutomationAdapter.ts";

describe("appAutomationTargetKey", () => {
  it("includes canonical app and conversation identity, not display text", () => {
    const first = appAutomationTargetKey({
      adapterId: "discord-accessibility",
      bundleId: "com.hnc.Discord",
      accountId: "discord:local",
      containerId: "123456789012345678",
      conversationId: "234567890123456789",
      expectedTitle: "Renamed channel",
    });
    const renamed = appAutomationTargetKey({
      adapterId: "discord-accessibility",
      bundleId: "com.hnc.Discord",
      accountId: "discord:local",
      containerId: "123456789012345678",
      conversationId: "234567890123456789",
      expectedTitle: "Another title",
    });
    assert.equal(first, renamed);
    assert.equal(
      first,
      "discord-accessibility:com.hnc.Discord:discord:local:123456789012345678:234567890123456789",
    );
  });
});
