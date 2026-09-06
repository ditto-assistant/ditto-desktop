import { describe, expect, it } from "vite-plus/test";

import {
  devicePollIntervalMs,
  INITIAL_DEVICE_LINK_STATE,
  interpretDeviceTokenResponse,
  reduceDeviceLink,
  verificationUrlWithCode,
  type DeviceCodeChallenge,
  type DeviceLinkState,
} from "./deviceCode";

const challenge: DeviceCodeChallenge = {
  deviceCode: "dev-1",
  userCode: "ABCD-1234",
  verificationUrl: "https://heyditto.ai/device",
  expiresInSeconds: 600,
  intervalSeconds: 5,
};

describe("reduceDeviceLink", () => {
  it("walks request → waiting → approved → linked", () => {
    let state: DeviceLinkState = INITIAL_DEVICE_LINK_STATE;
    state = reduceDeviceLink(state, { type: "start" });
    expect(state.phase).toBe("requesting");
    state = reduceDeviceLink(state, { type: "challenge", challenge });
    expect(state).toEqual({ phase: "waiting", challenge, slowDowns: 0 });
    state = reduceDeviceLink(state, { type: "pending" });
    expect(state.phase).toBe("waiting");
    state = reduceDeviceLink(state, { type: "slow-down" });
    expect(state).toEqual({ phase: "waiting", challenge, slowDowns: 1 });
    state = reduceDeviceLink(state, { type: "approved" });
    expect(state).toEqual({ phase: "linking", challenge });
    state = reduceDeviceLink(state, { type: "linked", keyHint: "208c" });
    expect(state).toEqual({ phase: "linked", keyHint: "208c" });
  });

  it("fails on expiry and denial and resets to idle", () => {
    const waiting = reduceDeviceLink(INITIAL_DEVICE_LINK_STATE, { type: "challenge", challenge });
    expect(reduceDeviceLink(waiting, { type: "expired" }).phase).toBe("failed");
    expect(reduceDeviceLink(waiting, { type: "denied" }).phase).toBe("failed");
    expect(reduceDeviceLink(waiting, { type: "reset" })).toEqual(INITIAL_DEVICE_LINK_STATE);
  });

  it("ignores approvals that arrive outside the waiting phase", () => {
    expect(reduceDeviceLink(INITIAL_DEVICE_LINK_STATE, { type: "approved" })).toEqual(
      INITIAL_DEVICE_LINK_STATE,
    );
  });
});

describe("device-code helpers", () => {
  it("stretches the poll interval on slow_down and floors it at 2.5s", () => {
    expect(devicePollIntervalMs(challenge, 0)).toBe(5000);
    expect(devicePollIntervalMs(challenge, 2)).toBe(15000);
    expect(devicePollIntervalMs({ ...challenge, intervalSeconds: 1 }, 0)).toBe(2500);
  });

  it("pre-fills the user code on the verification page", () => {
    expect(verificationUrlWithCode(challenge)).toBe("https://heyditto.ai/device?code=ABCD-1234");
  });

  it("interprets every token endpoint outcome", () => {
    expect(interpretDeviceTokenResponse({ access_token: "ditto_mcp_x" })).toEqual({
      kind: "approved",
      accessToken: "ditto_mcp_x",
    });
    expect(interpretDeviceTokenResponse({ error: "authorization_pending" }).kind).toBe("pending");
    expect(interpretDeviceTokenResponse({ error: "slow_down" }).kind).toBe("slow-down");
    expect(interpretDeviceTokenResponse({ error: "expired_token" }).kind).toBe("expired");
    expect(interpretDeviceTokenResponse({ error: "access_denied" }).kind).toBe("denied");
    expect(interpretDeviceTokenResponse(null).kind).toBe("error");
  });
});
