// DITTO: Discord link routing tests (upstream deleted the rest of this file in #22557).
import { describe, expect, it } from "vite-plus/test";

import { discordAppUrlForWebUrl } from "./ChatMarkdown";

describe("discordAppUrlForWebUrl", () => {
  it.each([
    ["https://discord.gg/gThEFQqh7", "discord://-/invite/gThEFQqh7"],
    ["https://discord.com/invite/gThEFQqh7", "discord://-/invite/gThEFQqh7"],
    [
      "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
      "discord://-/channels/123456789012345678/223456789012345678/323456789012345678",
    ],
  ])("routes %s through the Discord app", (webUrl, appUrl) => {
    expect(discordAppUrlForWebUrl(webUrl)).toBe(appUrl);
  });

  it("leaves Discord media and unrelated web links alone", () => {
    expect(
      discordAppUrlForWebUrl("https://media.discordapp.net/attachments/1/2/image.png"),
    ).toBeNull();
    expect(discordAppUrlForWebUrl("https://example.com/channels/1/2")).toBeNull();
  });
});
