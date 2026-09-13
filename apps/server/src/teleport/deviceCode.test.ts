import { describe, expect, it } from "vite-plus/test";

import { interpretDeviceTokenResponse, parseDeviceCodeGrant, parseJsonBody } from "./deviceCode.ts";

describe("parseDeviceCodeGrant", () => {
  it("reads a grant and defaults the timing fields", () => {
    expect(
      parseDeviceCodeGrant({
        device_code: "dev-1",
        user_code: "ABCD-1234",
        verification_url: "https://heyditto.ai/device",
      }),
    ).toEqual({
      deviceCode: "dev-1",
      userCode: "ABCD-1234",
      verificationUrl: "https://heyditto.ai/device",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    });
  });

  it("rejects bodies missing any of the three codes", () => {
    expect(parseDeviceCodeGrant(null)).toBeNull();
    expect(parseDeviceCodeGrant({ device_code: "dev-1", user_code: "" })).toBeNull();
  });
});

describe("interpretDeviceTokenResponse", () => {
  it("maps every token endpoint outcome", () => {
    expect(interpretDeviceTokenResponse({ access_token: "ditto_mcp_x" })).toEqual({
      kind: "approved",
      accessToken: "ditto_mcp_x",
    });
    expect(interpretDeviceTokenResponse({ error: "authorization_pending" }).kind).toBe("pending");
    expect(interpretDeviceTokenResponse({ error: "slow_down" }).kind).toBe("slow-down");
    expect(interpretDeviceTokenResponse({ error: "expired_token" }).kind).toBe("expired");
    expect(interpretDeviceTokenResponse({ error: "access_denied" }).kind).toBe("denied");
    expect(interpretDeviceTokenResponse(null).kind).toBe("error");
    expect(
      interpretDeviceTokenResponse({ error: "invalid_grant", error_description: "nope" }),
    ).toEqual({ kind: "error", message: "nope" });
  });
});

describe("parseJsonBody", () => {
  it("tolerates empty and malformed bodies", () => {
    expect(parseJsonBody("")).toBeNull();
    expect(parseJsonBody("{not json")).toBeNull();
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
  });
});
