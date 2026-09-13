import { describe, expect, it } from "vite-plus/test";

import { describeApiBaseOverride, resolveDittoAccountRows } from "./DittoAccountSettings.logic";

describe("resolveDittoAccountRows", () => {
  it("still offers the backend picker and Link this computer without Firebase config", () => {
    expect(resolveDittoAccountRows(false)).toEqual({
      signIn: false,
      unconfiguredNotice: true,
      backend: true,
      deviceLink: true,
      connections: false,
    });
  });

  it("adds sign-in and cloud connections once Firebase is configured", () => {
    expect(resolveDittoAccountRows(true)).toEqual({
      signIn: true,
      unconfiguredNotice: false,
      backend: true,
      deviceLink: true,
      connections: true,
    });
  });
});

describe("describeApiBaseOverride", () => {
  const production = "https://api.heyditto.ai";

  it("is silent when the default backend applies", () => {
    expect(describeApiBaseOverride({ stored: null, resolved: production, production })).toBeNull();
    expect(
      describeApiBaseOverride({ stored: production, resolved: production, production }),
    ).toBeNull();
  });

  it("names the active override and how to reset it", () => {
    const notice = describeApiBaseOverride({
      stored: "https://pr-2547-api.heyditto.ai",
      resolved: "https://pr-2547-api.heyditto.ai",
      production,
    });
    expect(notice).toContain("https://pr-2547-api.heyditto.ai");
    expect(notice).toContain('"ditto.apiBaseUrl"');
    expect(notice).toContain("Production");
  });
});
