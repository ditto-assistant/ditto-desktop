/**
 * Pure pieces of the Ditto device-code flow (RFC 8628) the server drives:
 * routes, the grant type, and the two response interpreters. Kept free of
 * Effect and I/O so they are unit-testable on their own.
 */

export const DEVICE_CODE_ROUTE = "/api/v2/mcp/device-code";
export const DEVICE_TOKEN_ROUTE = "/api/v2/mcp/device-token";

/** RFC 8628 grant type the Ditto token endpoint expects. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCodeGrant {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

/** Reads a device-code response body; null when it is not a usable grant. */
export function parseDeviceCodeGrant(body: unknown): DeviceCodeGrant | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (
    typeof record.device_code !== "string" ||
    record.device_code.length === 0 ||
    typeof record.user_code !== "string" ||
    record.user_code.length === 0 ||
    typeof record.verification_url !== "string" ||
    record.verification_url.length === 0
  ) {
    return null;
  }
  return {
    deviceCode: record.device_code,
    userCode: record.user_code,
    verificationUrl: record.verification_url,
    expiresInSeconds: typeof record.expires_in === "number" ? record.expires_in : 600,
    intervalSeconds: typeof record.interval === "number" ? record.interval : 5,
  };
}

export type DeviceTokenOutcome =
  | { readonly kind: "approved"; readonly accessToken: string }
  | { readonly kind: "pending" }
  | { readonly kind: "slow-down" }
  | { readonly kind: "expired" }
  | { readonly kind: "denied" }
  | { readonly kind: "error"; readonly message: string };

/** Interprets one token-endpoint response body (the status code carries no extra signal). */
export function interpretDeviceTokenResponse(body: unknown): DeviceTokenOutcome {
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

/** Lenient JSON parse: the token endpoint answers 400 with a JSON error body while pending. */
export function parseJsonBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
