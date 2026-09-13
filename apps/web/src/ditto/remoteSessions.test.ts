import { describe, expect, it } from "vite-plus/test";

import { orderSessionCommands, parseSlashCommandInput } from "./remoteSessions";

describe("parseSlashCommandInput", () => {
  it("splits a slash command from its arguments", () => {
    expect(parseSlashCommandInput("/compact --focus tests ")).toEqual({
      name: "compact",
      args: "--focus tests",
    });
    expect(parseSlashCommandInput("/review")).toEqual({ name: "review", args: "" });
  });

  it("treats anything else as a prompt", () => {
    expect(parseSlashCommandInput("fix the tests")).toBeNull();
    expect(parseSlashCommandInput("/")).toBeNull();
  });
});

describe("orderSessionCommands", () => {
  it("lists skills and custom commands before builtins and disables headless-unsupported ones", () => {
    const ordered = orderSessionCommands({
      mode: "headless",
      commands: [
        { name: "compact", source: "builtin", headless: false },
        { name: "deploy", source: "custom", headless: true },
        { name: "brand-kit", source: "skill", headless: true },
      ],
    });
    expect(ordered.map((command) => `${command.name}:${command.disabled}`)).toEqual([
      "brand-kit:false",
      "deploy:false",
      "compact:true",
    ]);
  });

  it("keeps every command enabled in TUI mode", () => {
    const ordered = orderSessionCommands({
      mode: "tui",
      commands: [{ name: "compact", source: "builtin", headless: false }],
    });
    expect(ordered[0]?.disabled).toBe(false);
  });
});
