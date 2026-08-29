import { describe, expect, it } from "@effect/vitest";

import { normalizeInboxSearchValue } from "./-inboxSearch";

describe("normalizeInboxSearchValue", () => {
  it("unwraps legacy JSON-encoded conversation ids", () => {
    expect(normalizeInboxSearchValue('"1542252144470528130"')).toBe("1542252144470528130");
  });

  it("preserves ordinary search values", () => {
    expect(normalizeInboxSearchValue("1542252144470528130")).toBe("1542252144470528130");
  });
});
