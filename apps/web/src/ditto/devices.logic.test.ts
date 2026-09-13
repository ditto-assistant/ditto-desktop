import { describe, expect, it } from "vite-plus/test";

import {
  describeHostPresence,
  formatPairingCode,
  isCompletePairingCode,
  normalizePairingCodeInput,
  pairingSecondsRemaining,
  partitionDittoHosts,
  sortHostSessions,
} from "./devices.logic";
import type { DittoHost } from "./hosts";

function host(overrides: Partial<DittoHost> & { readonly id: string }): DittoHost {
  return {
    kind: "desktop",
    name: overrides.id,
    presence: "offline",
    lastSeenAt: null,
    pairedHostIds: [],
    sessions: [],
    ...overrides,
  };
}

describe("partitionDittoHosts", () => {
  it("finds this machine by device id and splits paired hosts from the rest", () => {
    const self = host({ id: "h-self", deviceId: "desktop-abc", pairedHostIds: ["h-laptop"] });
    const laptop = host({ id: "h-laptop", presence: "online" });
    const phone = host({ id: "h-phone", kind: "mobile", pairedHostIds: ["h-self"] });
    const stranger = host({ id: "h-other" });

    const result = partitionDittoHosts([stranger, phone, laptop, self], "desktop-abc");

    expect(result.self).toBe(self);
    expect(result.paired.map((entry) => entry.id)).toEqual(["h-laptop", "h-phone"]);
    expect(result.others.map((entry) => entry.id)).toEqual(["h-other"]);
  });

  it("treats every host as unpaired when this machine is not registered yet", () => {
    const result = partitionDittoHosts([host({ id: "a" }), host({ id: "b" })], "desktop-new");
    expect(result.self).toBeNull();
    expect(result.paired).toEqual([]);
    expect(result.others.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("sorts online hosts first", () => {
    const result = partitionDittoHosts(
      [host({ id: "zed", presence: "online" }), host({ id: "abe" })],
      "none",
    );
    expect(result.others.map((entry) => entry.id)).toEqual(["zed", "abe"]);
  });
});

describe("pairing codes", () => {
  it("normalizes typed input to six digits", () => {
    expect(normalizePairingCodeInput("12-34 56 78")).toBe("123456");
    expect(isCompletePairingCode("12345")).toBe(false);
    expect(isCompletePairingCode("123456")).toBe(true);
  });

  it("formats the code in two groups", () => {
    expect(formatPairingCode("123456")).toBe("123 456");
    expect(formatPairingCode("12")).toBe("12");
  });

  it("counts down to expiry and never goes negative", () => {
    const now = Date.parse("2026-09-13T10:00:00Z");
    expect(pairingSecondsRemaining({ code: "1", expiresAt: "2026-09-13T10:05:00Z" }, now)).toBe(
      300,
    );
    expect(pairingSecondsRemaining({ code: "1", expiresAt: "2026-09-13T09:59:00Z" }, now)).toBe(0);
    expect(pairingSecondsRemaining({ code: "1", expiresAt: "nope" }, now)).toBe(0);
  });
});

describe("presentation", () => {
  it("describes presence with a relative last-seen time", () => {
    const now = Date.parse("2026-09-13T10:00:00Z");
    expect(describeHostPresence("online", null, now)).toBe("Online");
    expect(describeHostPresence("offline", null, now)).toBe("Offline");
    expect(describeHostPresence("offline", "2026-09-13T09:45:00Z", now)).toBe(
      "Offline · seen 15 min ago",
    );
    expect(describeHostPresence("offline", "2026-09-13T04:00:00Z", now)).toBe(
      "Offline · seen 6 h ago",
    );
  });

  it("orders running sessions first", () => {
    const sorted = sortHostSessions([
      {
        sessionId: "s1",
        threadId: "t1",
        harness: "codex",
        cwd: "/b",
        mode: "tui",
        status: "idle",
      },
      {
        sessionId: "s2",
        threadId: "t2",
        harness: "claude-code",
        cwd: "/a",
        mode: "headless",
        status: "running",
      },
    ]);
    expect(sorted.map((session) => session.sessionId)).toEqual(["s2", "s1"]);
  });
});
