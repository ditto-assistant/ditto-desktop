/**
 * Authenticated fetch against the Ditto API.
 *
 * Mirrors ditto-app's `fetchWithDittoHeaders`: a Firebase ID token as the
 * bearer, the account email, and the device/app/platform headers the backend
 * logs per request. Relative paths are resolved against the selected backend.
 *
 * @module ditto/api
 */
import { getDittoApiBaseUrl } from "./apiBase";
import type { DittoUser } from "./firebase";

const DEVICE_ID_STORAGE_KEY = "ditto.deviceId";

function createDeviceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `desktop-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function readOrCreateDeviceId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = createDeviceId();
    globalThis.localStorage?.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return "desktop";
  }
}

export class DittoApiError extends Error {
  override readonly name = "DittoApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `Ditto API responded with ${response.status}.`;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const message = record.error ?? record.message;
      if (typeof message === "string" && message.trim()) return message;
    }
  } catch {
    // Non-JSON error body; use the status text.
  }
  return response.statusText ? `${fallback} ${response.statusText}` : fallback;
}

/**
 * Sends a request as `user`. `path` may be a template using `{uid}` for the
 * account id, e.g. `/api/v5/users/{uid}/connectors`.
 */
export async function dittoFetch(
  user: DittoUser,
  path: string,
  init: Omit<RequestInit, "body"> & { readonly body?: unknown } = {},
): Promise<Response> {
  const token = await user.getIdToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-Email", user.email ?? "");
  headers.set("X-Device-ID", readOrCreateDeviceId());
  headers.set("X-App-Version", import.meta.env.APP_VERSION ?? "desktop");
  headers.set("X-Platform", "desktop");
  const { body: jsonBody, ...requestInit } = init;
  const request: RequestInit = { ...requestInit, headers };
  if (jsonBody !== undefined) {
    headers.set("Content-Type", "application/json");
    request.body = JSON.stringify(jsonBody);
  }
  const url = `${getDittoApiBaseUrl()}${path.replaceAll("{uid}", encodeURIComponent(user.uid))}`;
  return fetch(url, request);
}

/** `dittoFetch` that resolves the JSON body or throws a `DittoApiError`. */
export async function dittoFetchJson<T>(
  user: DittoUser,
  path: string,
  init: Omit<RequestInit, "body"> & { readonly body?: unknown } = {},
): Promise<T> {
  const response = await dittoFetch(user, path, init);
  if (!response.ok) {
    throw new DittoApiError(response.status, await readErrorMessage(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
