/**
 * Which Ditto backend the desktop talks to.
 *
 * Production by default (or whatever `DITTO_API_BASE_URL` baked in). A
 * per-machine override lets a developer point the app at one of the staging
 * slots to exercise a backend branch, mirroring ditto-app's Dev tab. The
 * override is a plain `localStorage` value so it survives restarts and never
 * touches the encrypted settings store.
 *
 * @module ditto/apiBase
 */

export interface DittoApiBaseOption {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

export const DITTO_PRODUCTION_API_BASE_URL = "https://api.heyditto.ai";

export const DITTO_API_BASE_OPTIONS: readonly DittoApiBaseOption[] = [
  { id: "production", label: "Production", url: DITTO_PRODUCTION_API_BASE_URL },
  { id: "staging-1", label: "Staging 1", url: "https://staging-api.heyditto.ai" },
  { id: "staging-2", label: "Staging 2", url: "https://staging-api-2.heyditto.ai" },
  { id: "staging-3", label: "Staging 3", url: "https://staging-api-3.heyditto.ai" },
  { id: "staging-4", label: "Staging 4", url: "https://staging-api-4.heyditto.ai" },
  { id: "staging-5", label: "Staging 5", url: "https://staging-api-5.heyditto.ai" },
  { id: "staging-6", label: "Staging 6", url: "https://staging-api-6.heyditto.ai" },
  { id: "staging-7", label: "Staging 7", url: "https://staging-api-7.heyditto.ai" },
  { id: "staging-8", label: "Staging 8", url: "https://staging-api-8.heyditto.ai" },
];

export const DITTO_API_BASE_STORAGE_KEY = "ditto.apiBaseUrl";

/** Normalizes a candidate base URL: https only, no trailing slash, known host. */
export function normalizeDittoApiBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const normalized = url.origin;
  return DITTO_API_BASE_OPTIONS.some((option) => option.url === normalized) ? normalized : null;
}

/**
 * Resolves the base URL from, in order: the per-machine override, the value
 * baked in at build time, production.
 */
export function resolveDittoApiBaseUrl(input: {
  readonly stored: string | null | undefined;
  readonly configured: string | null | undefined;
}): string {
  return (
    normalizeDittoApiBaseUrl(input.stored) ??
    normalizeDittoApiBaseUrl(input.configured) ??
    DITTO_PRODUCTION_API_BASE_URL
  );
}

function readStoredApiBaseUrl(): string | null {
  try {
    return globalThis.localStorage?.getItem(DITTO_API_BASE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function getDittoApiBaseUrl(): string {
  return resolveDittoApiBaseUrl({
    stored: readStoredApiBaseUrl(),
    configured: import.meta.env.VITE_DITTO_API_BASE_URL,
  });
}

export function setDittoApiBaseUrl(url: string | null): void {
  try {
    if (url === null) {
      globalThis.localStorage?.removeItem(DITTO_API_BASE_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(DITTO_API_BASE_STORAGE_KEY, url);
    }
  } catch {
    // Storage may be unavailable; the in-memory default still applies.
  }
}
