import { describe, expect, it } from "vite-plus/test";

import { isFirebaseAuthPopupUrl, stripEmbeddedBrowserTokens } from "./authPopup.ts";

describe("isFirebaseAuthPopupUrl", () => {
  it("allows the project's Firebase-hosted auth handler", () => {
    expect(
      isFirebaseAuthPopupUrl(
        "https://ditto-app-dev.firebaseapp.com/__/auth/handler?apiKey=x&authType=signInViaPopup",
      ),
    ).toBe(true);
    expect(isFirebaseAuthPopupUrl("https://ditto-app-dev.web.app/__/auth/iframe")).toBe(true);
  });

  it("denies everything else", () => {
    expect(isFirebaseAuthPopupUrl("https://accounts.google.com/o/oauth2/auth")).toBe(false);
    expect(isFirebaseAuthPopupUrl("https://ditto-app-dev.firebaseapp.com/settings")).toBe(false);
    expect(isFirebaseAuthPopupUrl("http://ditto-app-dev.firebaseapp.com/__/auth/handler")).toBe(
      false,
    );
    expect(isFirebaseAuthPopupUrl("https://firebaseapp.com/__/auth/handler")).toBe(false);
    expect(isFirebaseAuthPopupUrl("https://evil.example.test/__/auth/handler")).toBe(false);
    expect(isFirebaseAuthPopupUrl("javascript:alert(1)")).toBe(false);
    expect(isFirebaseAuthPopupUrl(undefined)).toBe(false);
  });
});

describe("stripEmbeddedBrowserTokens", () => {
  it("removes the Electron and app product tokens and keeps Chrome's", () => {
    expect(
      stripEmbeddedBrowserTokens(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ditto/0.0.27-alpha.1 Chrome/146.0.0.0 Electron/41.5.0 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    );
  });

  it("leaves a plain browser user agent alone", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
    expect(stripEmbeddedBrowserTokens(ua)).toBe(ua);
  });
});
