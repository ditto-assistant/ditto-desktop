/**
 * Which cookies from a Messages-for-web sign-in the Ditto backend needs.
 *
 * Mirrors the backend's `googleMessagesRequiredCookies`: libgm starts Google
 * Account pairing from the Google session cookies of a browser signed in at
 * messages.google.com. `OSID` is set only once Messages for web itself has
 * loaded, so it doubles as the "sign-in finished" signal the pairing window
 * polls for. Everything that is not Google auth material is dropped before
 * the cookies leave the machine.
 *
 * Electron-free so it is unit-testable; the sign-in window feeds it
 * `session.cookies.get()` results.
 *
 * @module googlemessages/googleMessagesCookies
 */

export const GOOGLE_MESSAGES_REQUIRED_COOKIES = [
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "OSID",
] as const;

const OPTIONAL_COOKIES: ReadonlySet<string> = new Set(["LSID", "SIDCC", "NID", "CONSENT", "SOCS"]);

/** The subset of Electron's `Cookie` this module reads; `domain` is optional there too. */
export interface BrowserCookie {
  readonly name: string;
  readonly domain?: string | undefined;
  readonly value: string;
}

export interface GoogleMessagesCookieSelection {
  /** True once every required cookie is present: sign-in is complete. */
  readonly ready: boolean;
  /** Only the Google auth cookies, keyed by name. */
  readonly cookies: Readonly<Record<string, string>>;
  /** Required cookies not seen yet. */
  readonly missing: readonly string[];
}

function isGoogleDomain(domain: string): boolean {
  const host = domain.trim().replace(/^\./, "").toLowerCase();
  return host === "google.com" || host.endsWith(".google.com");
}

function isWantedCookie(name: string): boolean {
  return (
    (GOOGLE_MESSAGES_REQUIRED_COOKIES as readonly string[]).includes(name) ||
    OPTIONAL_COOKIES.has(name) ||
    name.startsWith("__Secure-") ||
    name.startsWith("__Host-")
  );
}

// Control characters and ";" can't travel in a Cookie header.
function isSafeCookieValue(value: string): boolean {
  if (value.length === 0 || value.length > 16 * 1024) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x3b /* ; */) return false;
  }
  return true;
}

/**
 * Picks the Google auth cookies out of a session's cookie list. Google's
 * cookies live on `.google.com`; `OSID` on `messages.google.com`. A same-named
 * cookie from any other site never counts.
 */
export function selectGoogleMessagesCookies(
  cookies: Iterable<BrowserCookie>,
): GoogleMessagesCookieSelection {
  const selected: Record<string, string> = {};
  for (const cookie of cookies) {
    if (!isWantedCookie(cookie.name) || !isSafeCookieValue(cookie.value)) continue;
    if (!isGoogleDomain(cookie.domain ?? "")) continue;
    if (cookie.name in selected) continue;
    selected[cookie.name] = cookie.value;
  }
  const missing = GOOGLE_MESSAGES_REQUIRED_COOKIES.filter((name) => !(name in selected));
  return { ready: missing.length === 0, cookies: selected, missing };
}
