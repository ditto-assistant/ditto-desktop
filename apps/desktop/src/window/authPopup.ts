/**
 * Which `window.open` calls the main window may satisfy with a child window.
 *
 * The desktop shell denies popups and hands safe URLs to the OS browser. Sign
 * in with Ditto is the one exception: the Firebase Auth SDK's Google flow
 * opens the project's auth handler in a popup and expects to talk to it via
 * `window.opener`, which an external browser can't do. Only Firebase-hosted
 * auth handlers qualify — the popup then navigates to accounts.google.com on
 * its own.
 *
 * Electron-free so it is unit-testable; `DesktopWindow.ts` applies it.
 *
 * @module window/authPopup
 */

const FIREBASE_AUTH_HOST_SUFFIXES = [".firebaseapp.com", ".web.app"] as const;
const FIREBASE_AUTH_HANDLER_PATH = "/__/auth/";

export function isFirebaseAuthPopupUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== "string") return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  const hostedByFirebase = FIREBASE_AUTH_HOST_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
  return hostedByFirebase && url.pathname.startsWith(FIREBASE_AUTH_HANDLER_PATH);
}

/**
 * Chromium's default user agent with the Electron and app product tokens
 * removed. Google's sign-in pages refuse embedded browsers they recognize by
 * user agent ("this browser or app may not be secure"); a stock Chrome string
 * is what every Electron client that hosts Google sign-in presents.
 */
export function stripEmbeddedBrowserTokens(userAgent: string): string {
  return userAgent
    .replace(/\sElectron\/[\d.]+/g, "")
    .replace(/\s(t3code|Ditto|ditto-desktop)\/[\d.]+(-[\w.]+)?/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
