import { renderToStaticMarkup } from "react-dom/server";
import { ChannelAccountId, ChannelConversationId, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("renders a chat-person result before workspace paths", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "chat-context:discord:local:liam-dm",
            type: "chat-context",
            conversation: {
              accountId: ChannelAccountId.make("discord:local"),
              conversationId: ChannelConversationId.make("liam-dm"),
              service: "discord",
              title: "Liam",
              kind: "direct",
              participants: [{ id: "liam", displayName: "Liam" }],
              completeness: "device_cache_partial",
            },
            label: "@Liam",
            description: "Attach recent messages and available files",
          },
          {
            id: "path:file:liam.ts",
            type: "path",
            path: "src/liam.ts",
            pathKind: "file",
            label: "liam.ts",
            description: "src",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="path"
        activeItemId="chat-context:discord:local:liam-dm"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("@Liam");
    expect(markup).toContain("Attach recent messages and available files");
    expect(markup).toContain("discord chat");
    expect(markup.indexOf("@Liam")).toBeLessThan(markup.indexOf("liam.ts"));
  });

  it("renders slash-command results as an attached composer drawer", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={null}
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('data-composer-command-drawer="true"');
    expect(markup).toContain("chat-composer-drawer-surface");
    expect(markup).toContain("chat-composer-drawer-attached");
    expect(markup).not.toContain("dropdown-glass");
  });

  it("renders commands without a category heading or invented icons", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="slash:model"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("/model");
    expect(markup).toContain("Switch response model for this thread");
    expect(markup).not.toContain("Built-in");
    expect(markup).not.toContain("<svg");
    expect(markup).toContain("font-sans text-xs font-medium");
    expect(markup).not.toContain("font-mono");
    expect(markup).not.toContain("grid-cols-");
    expect(markup).toContain("max-w-[45%]");
    expect(markup).toContain("text-left");
  });

  it("renders the skill source icon inside its badge", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:browser",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "browser",
              path: "/Users/maria/.codex/plugins/browser/skills/browser/SKILL.md",
              scope: "user",
              enabled: true,
            },
            label: "Browser",
            description: "Open and control the in-app browser",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:codex:browser"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("Browser");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain(">App Skill</span>");
    expect(markup).toContain("Open and control the in-app browser");
    expect(markup).toContain("max-w-[48ch]");
    expect(markup).toContain("text-secondary-label text-xs");
    expect(markup).toContain("ms-auto");
    expect(markup).toContain("text-current");
    expect(markup.indexOf("Open and control the in-app browser")).toBeLessThan(
      markup.indexOf(">App Skill</span>"),
    );
    expect(markup).toContain("<svg");
    expect(markup.indexOf('data-slot="badge"')).toBeLessThan(markup.indexOf("<svg"));
  });

  it("keeps slash skills aligned with the source icon inside the badge", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:ask-matt",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "ask-matt",
              displayName: "Ask Matt",
              path: "/skills/ask-matt/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            label: "/skill:ask-matt",
            description: "Find the right skill or workflow",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="skill:codex:ask-matt"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('<span class="text-secondary-label">/skill:</span>Ask Matt');
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain(">Repo</span>");
    expect(markup).toContain("Find the right skill or workflow");
    expect(markup).not.toContain("font-medium text-secondary-label");
  });
});
