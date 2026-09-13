import { describe, expect, it } from "vite-plus/test";

import { pickDeviceLinkEnvironmentId } from "./deviceLinkEnvironment";

describe("pickDeviceLinkEnvironmentId", () => {
  it("prefers the primary environment", () => {
    expect(
      pickDeviceLinkEnvironmentId("env-primary", [
        { environmentId: "env-relay" },
        { environmentId: "env-primary" },
      ]),
    ).toBe("env-primary");
  });

  it("falls back to the first registered environment when there is no primary", () => {
    expect(pickDeviceLinkEnvironmentId(null, [{ environmentId: "env-relay" }])).toBe("env-relay");
  });

  it("returns null only when the registry is empty", () => {
    expect(pickDeviceLinkEnvironmentId(null, [])).toBeNull();
  });
});
