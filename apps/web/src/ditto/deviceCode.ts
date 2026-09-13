/**
 * "Link this computer" with Ditto through the OAuth device-code flow.
 *
 * The desktop server owns the transport: it asks the Ditto API for a device
 * code, polls the token endpoint, and stores the resulting long-lived
 * `ditto_mcp_` key in its secret store. Server-side fetches carry no browser
 * origin, so the flow works from any renderer origin without CORS. The
 * renderer keeps only this pure state machine plus the timing helpers, so the
 * transitions are unit-testable without React or network.
 *
 * @module ditto/deviceCode
 */
import type { DittoDeviceLinkChallenge } from "@t3tools/contracts";

export type DeviceCodeChallenge = DittoDeviceLinkChallenge;

export type DeviceLinkState =
  | { readonly phase: "idle" }
  | { readonly phase: "requesting" }
  | {
      readonly phase: "waiting";
      readonly challenge: DeviceCodeChallenge;
      readonly slowDowns: number;
    }
  | { readonly phase: "linking"; readonly challenge: DeviceCodeChallenge }
  | { readonly phase: "linked"; readonly keyHint: string }
  | { readonly phase: "failed"; readonly message: string };

export type DeviceLinkEvent =
  | { readonly type: "start" }
  | { readonly type: "challenge"; readonly challenge: DeviceCodeChallenge }
  | { readonly type: "pending" }
  | { readonly type: "slow-down" }
  | { readonly type: "approved" }
  | { readonly type: "linked"; readonly keyHint: string }
  | { readonly type: "expired" }
  | { readonly type: "denied" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "reset" };

export const INITIAL_DEVICE_LINK_STATE: DeviceLinkState = { phase: "idle" };

export function reduceDeviceLink(state: DeviceLinkState, event: DeviceLinkEvent): DeviceLinkState {
  switch (event.type) {
    case "start":
      return { phase: "requesting" };
    case "challenge":
      return { phase: "waiting", challenge: event.challenge, slowDowns: 0 };
    case "pending":
      return state;
    case "slow-down":
      return state.phase === "waiting" ? { ...state, slowDowns: state.slowDowns + 1 } : state;
    case "approved":
      return state.phase === "waiting" ? { phase: "linking", challenge: state.challenge } : state;
    case "linked":
      return { phase: "linked", keyHint: event.keyHint };
    case "expired":
      return {
        phase: "failed",
        message: "The code expired before it was approved. Start again to get a new one.",
      };
    case "denied":
      return { phase: "failed", message: "The request was denied in the Ditto app." };
    case "error":
      return { phase: "failed", message: event.message };
    case "reset":
      return INITIAL_DEVICE_LINK_STATE;
  }
}

/** Poll cadence: the server's interval, stretched by 5s per `slow_down`, never under 2.5s. */
export function devicePollIntervalMs(challenge: DeviceCodeChallenge, slowDowns: number): number {
  const base = Math.max(challenge.intervalSeconds, 2.5) * 1000;
  return base + slowDowns * 5000;
}

/** Epoch millis after which the renderer stops polling; the server enforces the real expiry. */
export function deviceLinkDeadlineMs(challenge: DeviceCodeChallenge): number {
  const parsed = Date.parse(challenge.expiresAt);
  return Number.isFinite(parsed) ? parsed : Date.now() + 600_000;
}

/** The verification page with the user code pre-filled, e.g. `https://heyditto.ai/device?code=ABCD-1234`. */
export function verificationUrlWithCode(challenge: DeviceCodeChallenge): string {
  try {
    const url = new URL(challenge.verificationUrl);
    url.searchParams.set("code", challenge.userCode);
    return url.toString();
  } catch {
    return challenge.verificationUrl;
  }
}
