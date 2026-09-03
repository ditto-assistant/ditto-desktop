import { describe, expect, it } from "vite-plus/test";

import { selectGoogleMessagesCookies } from "./googleMessagesCookies.ts";

const signedIn = [
  { name: "SID", domain: ".google.com", value: "sid" },
  { name: "HSID", domain: ".google.com", value: "hsid" },
  { name: "SSID", domain: ".google.com", value: "ssid" },
  { name: "APISID", domain: ".google.com", value: "apisid" },
  { name: "SAPISID", domain: ".google.com", value: "sapisid" },
  { name: "__Secure-1PSIDTS", domain: ".google.com", value: "ts" },
  { name: "NID", domain: ".google.com", value: "nid" },
  { name: "_ga", domain: ".google.com", value: "tracking" },
  { name: "SID", domain: "example.com", value: "other-site" },
];

describe("selectGoogleMessagesCookies", () => {
  it("is not ready until Messages for web has set OSID", () => {
    const selection = selectGoogleMessagesCookies(signedIn);
    expect(selection.ready).toBe(false);
    expect(selection.missing).toEqual(["OSID"]);
  });

  it("keeps only Google auth cookies once sign-in completes", () => {
    const selection = selectGoogleMessagesCookies([
      ...signedIn,
      { name: "OSID", domain: "messages.google.com", value: "osid" },
    ]);
    expect(selection.ready).toBe(true);
    expect(selection.missing).toEqual([]);
    expect(selection.cookies).toEqual({
      SID: "sid",
      HSID: "hsid",
      SSID: "ssid",
      APISID: "apisid",
      SAPISID: "sapisid",
      OSID: "osid",
      "__Secure-1PSIDTS": "ts",
      NID: "nid",
    });
  });

  it("never lets another site's cookie stand in for a Google one", () => {
    const selection = selectGoogleMessagesCookies([
      { name: "SID", domain: "example.com", value: "other-site" },
      { name: "OSID", domain: "evil.example", value: "fake" },
    ]);
    expect(selection.cookies).toEqual({});
    expect(selection.missing).toHaveLength(6);
  });

  it("drops values that could not travel in a cookie header", () => {
    const selection = selectGoogleMessagesCookies([
      { name: "SID", domain: ".google.com", value: "bad;value" },
      { name: "HSID", domain: ".google.com", value: "" },
    ]);
    expect(selection.cookies).toEqual({});
  });
});
