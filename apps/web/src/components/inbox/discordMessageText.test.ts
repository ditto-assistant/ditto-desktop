import { describe, expect, it } from "@effect/vitest";

import { resolveDiscordMessageText } from "./discordMessageText";

describe("resolveDiscordMessageText", () => {
  it("resolves user and channel mentions without changing code", () => {
    const text = "Hi <@123> in <#456> — `<@123>`\n```txt\n<#456>\n```";
    expect(
      resolveDiscordMessageText(text, [
        { id: "123", kind: "user", displayName: "Peyton" },
        { id: "456", kind: "channel", displayName: "product-dev" },
      ]),
    ).toBe("Hi @Peyton in #product\\-dev — `<@123>`\n```txt\n<#456>\n```");
  });

  it("leaves unresolved mentions intact", () => {
    expect(resolveDiscordMessageText("Hello <@999>", [])).toBe("Hello <@999>");
  });
});
