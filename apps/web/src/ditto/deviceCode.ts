/**
 * "Link this computer" with Ditto through the OAuth device-code flow.
 *
 * The desktop asks the Ditto API for a device code, sends the user to the
 * verification page (the code is pre-filled), and polls until the account
 * approves it. The result is a long-lived `ditto_mcp_` key which the server
 * stores in its secret store; the renderer only keeps the pure state machine
 * below so the transitions are unit-testable without React or network.
 *
 * @module ditto/deviceCode
 */
import { getDittoApiBaseUrl } from "./apiBase";

export interface DeviceCodeChallenge {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export type DeviceLinkState =
  | { readonly phase: "idle" }
  | { readonly phase: "requesting" }
  | { readonly phase: "waiting"; readonly challenge: DeviceCodeChallenge; readonly slowDowns: number }
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

/** RFC 8628 grant type the Ditto token endpoint expects. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

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

export type DeviceTokenPoll =
  | { readonly kind: "approved"; readonly accessToken: string }
  | { readonly kind: "pending" }
  | { readonly kind: "slow-down" }
  | { readonly kind: "expired" }
  | { readonly kind: "denied" }
  | { readonly kind: "error"; readonly message: string };

/** Interprets one token-endpoint response body. */
export function interpretDeviceTokenResponse(body: unknown): DeviceTokenPoll {
  if (typeof body !== "object" || body === null) {
    return { kind: "error", message: "Ditto returned an unexpected response." };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.access_token === "string" && record.access_token.length > 0) {
    return { kind: "approved", accessToken: record.access_token };
  }
  switch (record.error) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow-down" };
    case "expired_token":
      return { kind: "expired" };
    case "access_denied":
      return { kind: "denied" };
    default:
      return {
        kind: "error",
        message:
          typeof record.error_description === "string"
            ? record.error_description
            : typeof record.error === "string"
              ? `Ditto returned ${record.error}.`
              : "Ditto returned an unexpected response.",
      };
  }
}

/** Unauthenticated JSON POST against the selected Ditto backend. */
export async function dittoFetchAnonymous<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${getDittoApiBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Platform": "desktop" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok && !(typeof parsed === "object" && parsed !== null && "error" in parsed)) {
    throw new Error(`Ditto API responded with ${response.status}.`);
  }
  return parsed as T;
}

export async function requestDeviceCode(): Promise<DeviceCodeChallenge> {
  const body = await dittoFetchAnonymous<{
    device_code?: string;
    user_code?: string;
    verification_url?: string;
    expires_in?: number;
    interval?: number;
  }>("/api/v2/mcp/device-code", {});
  if (!body?.device_code || !body.user_code || !body.verification_url) {
    throw new Error("Ditto did not return a device code.");
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUrl: body.verification_url,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 600,
    intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
  };
}

export async function pollDeviceToken(challenge: DeviceCodeChallenge): Promise<DeviceTokenPoll> {
  const body = await dittoFetchAnonymous<unknown>("/api/v2/mcp/device-token", {
    device_code: challenge.deviceCode,
    grant_type: DEVICE_CODE_GRANT_TYPE,
  });
  return interpretDeviceTokenResponse(body);
}
