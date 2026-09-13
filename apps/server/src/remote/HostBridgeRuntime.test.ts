import { describe, expect, it } from "@effect/vitest";

import { buildTurnPrompt, safeAttachmentFileName } from "./HostBridgeAttachments.ts";
import { hostBridgeSocketUrl, resolveHostBridgeConfig } from "./HostBridgeConfig.ts";
import {
  approvalDecisionForAnswer,
  commandsFromProviderSnapshot,
  harnessForProvider,
  parsePromptId,
  promptIdFor,
  sessionStatusForProvider,
} from "./HostBridgeRuntime.ts";

describe("host bridge runtime mappings", () => {
  it("only exposes Claude Code and Codex threads", () => {
    expect(harnessForProvider("claudeAgent")).toBe("claude-code");
    expect(harnessForProvider("codex")).toBe("codex");
    expect(harnessForProvider("cursor")).toBeNull();
    expect(harnessForProvider(null)).toBeNull();
  });

  it("derives running status from the provider session or an active turn", () => {
    expect(sessionStatusForProvider("ready", null)).toBe("idle");
    expect(sessionStatusForProvider("running", null)).toBe("running");
    expect(sessionStatusForProvider("ready", "turn-1")).toBe("running");
  });

  it("builds the v1.1 catalog from slash commands and user-invocable skills", () => {
    const commands = commandsFromProviderSnapshot({
      slashCommands: [
        { name: "/review", description: "Review the diff" },
        { name: "model", input: { hint: "<model>" } },
      ],
      skills: [
        { name: "brand-kit", enabled: true, shortDescription: "Apply the kit", scope: "plugin" },
        { name: "hidden", enabled: true, userInvocable: false },
        { name: "off", enabled: false },
        { name: "deploy", enabled: true, description: "Ship it" },
      ],
    });
    expect(commands).toEqual([
      { name: "brand-kit", description: "Apply the kit", source: "plugin", headless: true },
      { name: "deploy", description: "Ship it", source: "skill", headless: true },
      { name: "model", source: "builtin", argsHint: "<model>", headless: true },
      { name: "review", description: "Review the diff", source: "builtin", headless: true },
    ]);
  });

  it("round-trips prompt ids and maps free-text answers onto decisions", () => {
    const promptId = promptIdFor({ kind: "approval", requestId: "req:with:colons" });
    expect(parsePromptId(promptId)).toEqual({ kind: "approval", requestId: "req:with:colons" });
    expect(parsePromptId("bogus")).toBeNull();
    expect(approvalDecisionForAnswer("acceptAlways")).toBe("acceptAlways");
    expect(approvalDecisionForAnswer("yes")).toBe("accept");
    expect(approvalDecisionForAnswer("no way")).toBe("decline");
  });
});

describe("attachments", () => {
  it("keeps attachment names inside the turn directory", () => {
    expect(safeAttachmentFileName("../../etc/passwd", "x")).toBe("passwd");
    expect(safeAttachmentFileName("..", "fallback")).toBe("fallback");
    expect(safeAttachmentFileName("C:\\Users\\me\\report.pdf", "x")).toBe("report.pdf");
  });

  it("appends the attached-files list to the prompt", () => {
    expect(buildTurnPrompt("Look at these", ["a.png", "b/c.txt"])).toBe(
      "Look at these\n\nAttached files:\n- a.png\n- b/c.txt",
    );
    expect(buildTurnPrompt("   ", ["a.png"])).toBe("Attached files:\n- a.png");
    expect(buildTurnPrompt("plain", [])).toBe("plain");
  });
});

describe("config", () => {
  it("enables host mode from the device-link key and derives the socket url", () => {
    const config = resolveHostBridgeConfig({
      env: { DITTO_DEVICE_LINK_KEY: "ditto_mcp_abc", DITTO_API_URL: "https://api.staging.test/" },
      hostName: "mac",
      platform: "darwin",
      version: "1.0.0",
    });
    expect(config.enabled).toBe(true);
    expect(config.socketUrl).toBe("wss://api.staging.test/api/v5/hosts/ws");
    expect(hostBridgeSocketUrl("http://localhost:3400")).toBe(
      "ws://localhost:3400/api/v5/hosts/ws",
    );
  });

  it("stays off without a key or when opted out", () => {
    const base = { hostName: "mac", platform: "darwin", version: "1.0.0" };
    expect(resolveHostBridgeConfig({ ...base, env: {} }).enabled).toBe(false);
    expect(
      resolveHostBridgeConfig({
        ...base,
        env: { DITTO_DEVICE_LINK_KEY: "k", DITTO_REMOTE_CONTROL: "0" },
      }).enabled,
    ).toBe(false);
  });
});
