// @effect-diagnostics globalTimers:off -- Promise-based window lifecycle driven by Electron events; the cookie poll and sign-in timeout run outside any Effect runtime and are cleared by the same close path.
/**
 * Google Account pairing for Google Messages: the sign-in window.
 *
 * Opens an isolated, in-memory browser session at Messages for web with a
 * stock Chrome user agent, lets the user sign in to Google (2-step, passkeys,
 * account chooser, whatever their account needs), and watches the session's
 * cookies until Messages for web has loaded. It then hands back only the
 * Google auth cookies, closes the window, and wipes the session, so the
 * cookies exist afterwards only in the backend request that starts pairing.
 *
 * Why a throwaway session: cookies copied out of a normal Chrome profile are
 * device-bound (DBSC) and rotate, which breaks pairing; Electron sessions are
 * not, and a session nobody keeps can't rotate anything.
 *
 * @module googlemessages/GoogleMessagesSignIn
 */
import { BrowserWindow, session as electronSession } from "electron";

import { stripEmbeddedBrowserTokens } from "../window/authPopup.ts";
import { selectGoogleMessagesCookies } from "./googleMessagesCookies.ts";

export type GoogleMessagesSignInOutcome =
  | { readonly status: "cookies"; readonly cookies: Readonly<Record<string, string>> }
  | { readonly status: "cancelled"; readonly reason: "closed" | "timeout" | "superseded" };

/** No `persist:` prefix: the session lives in memory and dies with the window. */
const SIGN_IN_PARTITION = "ditto-google-messages-sign-in";
const SIGN_IN_URL =
  "https://accounts.google.com/AccountChooser?continue=https://messages.google.com/web/config";
const COOKIE_POLL_INTERVAL_MS = 750;
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

interface ActiveSignIn {
  readonly window: BrowserWindow;
  readonly finish: (outcome: GoogleMessagesSignInOutcome) => void;
}

let active: ActiveSignIn | null = null;

/** Closes an in-progress sign-in window, if any; its caller gets "cancelled". */
export function cancelGoogleMessagesSignIn(reason: "closed" | "superseded" = "closed"): void {
  const current = active;
  if (current === null) return;
  active = null;
  current.finish({ status: "cancelled", reason });
}

async function wipe(browserSession: Electron.Session): Promise<void> {
  try {
    await browserSession.clearStorageData();
    await browserSession.clearCache();
  } catch {
    // The session is in-memory and about to be dropped either way.
  }
}

/**
 * Runs one sign-in. Only one can be open at a time: starting another cancels
 * the first ("superseded").
 */
export function signInToGoogleMessages(): Promise<GoogleMessagesSignInOutcome> {
  cancelGoogleMessagesSignIn("superseded");

  const browserSession = electronSession.fromPartition(SIGN_IN_PARTITION);
  browserSession.setUserAgent(stripEmbeddedBrowserTokens(browserSession.getUserAgent()));

  const window = new BrowserWindow({
    width: 560,
    height: 760,
    title: "Sign in to Google Messages",
    autoHideMenuBar: true,
    webPreferences: {
      partition: SIGN_IN_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  return new Promise<GoogleMessagesSignInOutcome>((resolve) => {
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const onClosed = () => finish({ status: "cancelled", reason: "closed" });

    function finish(outcome: GoogleMessagesSignInOutcome) {
      if (settled) return;
      settled = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (active?.window === window) active = null;
      window.removeListener("closed", onClosed);
      if (!window.isDestroyed()) window.close();
      void wipe(browserSession).finally(() => resolve(outcome));
    }

    const poll = async () => {
      if (settled || window.isDestroyed()) return;
      try {
        const cookies = await browserSession.cookies.get({});
        const selection = selectGoogleMessagesCookies(cookies);
        if (selection.ready) {
          finish({ status: "cookies", cookies: selection.cookies });
          return;
        }
      } catch {
        // Transient; the next poll retries.
      }
      if (!settled) pollTimer = setTimeout(() => void poll(), COOKIE_POLL_INTERVAL_MS);
    };

    active = { window, finish };
    window.once("closed", onClosed);
    // Keep the sign-in inside this window: Google's flow stays on Google, and
    // anything else (help links) is not needed to finish signing in.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    timeoutTimer = setTimeout(
      () => finish({ status: "cancelled", reason: "timeout" }),
      SIGN_IN_TIMEOUT_MS,
    );
    void window.loadURL(SIGN_IN_URL).catch(() => {
      // A failed initial load still leaves the window usable; polling continues.
    });
    pollTimer = setTimeout(() => void poll(), COOKIE_POLL_INTERVAL_MS);
  });
}
