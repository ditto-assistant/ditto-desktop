import { describe, expect, it } from "vite-plus/test";

import { teleportHarnessForProvider } from "./teleport.ts";

describe("teleportHarnessForProvider", () => {
  it("maps the real provider driver kinds onto cloud harnesses", () => {
    expect(teleportHarnessForProvider("claudeAgent")).toBe("claude-code");
    expect(teleportHarnessForProvider("codex")).toBe("codex");
  });

  it("has no harness for providers the cloud runner cannot resume", () => {
    for (const provider of ["cursor", "grok", "opencode", "ditto", "", null, undefined]) {
      expect(teleportHarnessForProvider(provider)).toBeNull();
    }
  });
});
