import { describe, expect, it } from "vite-plus/test";

import {
  deviceLinkDeadlineMs,
  devicePollIntervalMs,
  INITIAL_DEVICE_LINK_STATE,
  reduceDeviceLink,
  verificationUrlWithCode,
  type DeviceCodeChallenge,
  type DeviceLinkState,
} from "./deviceCode";

const challenge: DeviceCodeChallenge = {
  linkId: "link-1",
  userCode: "ABCD-1234",
  verificationUrl: "https://heyditto.ai/device",
  expiresAt: "2030-01-01T00:10:00.000Z",
  intervalSeconds: 5,
};

function run(events: Parameters<typeof reduceDeviceLink>[1][]): DeviceLinkState {
  return events.reduce(reduceDeviceLink, INITIAL_DEVICE_LINK_STATE);
}

describe("reduceDeviceLink", () => {
  it("walks request → waiting → approved → linked", () => {
    expect(run([{ type: "start" }])).toEqual({ phase: "requesting" });
    expect(run([{ type: "start" }, { type: "challenge", challenge }])).toEqual({
      phase: "waiting",
      challenge,
      slowDowns: 0,
    });
    expect(
      run([{ type: "start" }, { type: "challenge", challenge }, { type: "slow-down" }]),
    ).toMatchObject({ phase: "waiting", slowDowns: 1 });
    expect(
      run([{ type: "start" }, { type: "challenge", challenge }, { type: "approved" }]),
    ).toEqual({ phase: "linking", challenge });
    expect(run([{ type: "linked", keyHint: "9f3a" }])).toEqual({
      phase: "linked",
      keyHint: "9f3a",
    });
  });

  it("fails on expiry and denial and resets to idle", () => {
    expect(run([{ type: "start" }, { type: "expired" }]).phase).toBe("failed");
    expect(run([{ type: "start" }, { type: "denied" }]).phase).toBe("failed");
    expect(run([{ type: "start" }, { type: "denied" }, { type: "reset" }])).toEqual(
      INITIAL_DEVICE_LINK_STATE,
    );
  });

  it("ignores approvals that arrive outside the waiting phase", () => {
    expect(run([{ type: "approved" }])).toEqual(INITIAL_DEVICE_LINK_STATE);
    expect(run([{ type: "start" }, { type: "approved" }])).toEqual({ phase: "requesting" });
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

  it("derives the polling deadline from the server's expiry", () => {
    expect(deviceLinkDeadlineMs(challenge)).toBe(Date.parse("2030-01-01T00:10:00.000Z"));
    expect(deviceLinkDeadlineMs({ ...challenge, expiresAt: "garbage" })).toBeGreaterThan(
      Date.now(),
    );
  });
});
