import { describe, expect, it } from "vite-plus/test";

import {
  DITTO_PRODUCTION_API_BASE_URL,
  normalizeDittoApiBaseUrl,
  resolveDittoApiBaseUrl,
} from "./apiBase";

describe("normalizeDittoApiBaseUrl", () => {
  it("accepts known Ditto hosts and strips paths", () => {
    expect(normalizeDittoApiBaseUrl("https://staging-api-8.heyditto.ai/")).toBe(
      "https://staging-api-8.heyditto.ai",
    );
    expect(normalizeDittoApiBaseUrl("https://api.heyditto.ai/api/v5")).toBe(
      DITTO_PRODUCTION_API_BASE_URL,
    );
  });

  it("rejects unknown hosts, plain http, and junk", () => {
    expect(normalizeDittoApiBaseUrl("https://evil.example.test")).toBeNull();
    expect(normalizeDittoApiBaseUrl("http://api.heyditto.ai")).toBeNull();
    expect(normalizeDittoApiBaseUrl("not a url")).toBeNull();
    expect(normalizeDittoApiBaseUrl("")).toBeNull();
    expect(normalizeDittoApiBaseUrl(undefined)).toBeNull();
  });
});

describe("resolveDittoApiBaseUrl", () => {
  it("prefers the per-machine override, then the built-in value, then production", () => {
    expect(
      resolveDittoApiBaseUrl({
        stored: "https://staging-api-3.heyditto.ai",
        configured: "https://staging-api-8.heyditto.ai",
      }),
    ).toBe("https://staging-api-3.heyditto.ai");
    expect(
      resolveDittoApiBaseUrl({ stored: null, configured: "https://staging-api-8.heyditto.ai" }),
    ).toBe("https://staging-api-8.heyditto.ai");
    expect(resolveDittoApiBaseUrl({ stored: null, configured: undefined })).toBe(
      DITTO_PRODUCTION_API_BASE_URL,
    );
  });

  it("ignores an invalid override instead of trusting it", () => {
    expect(
      resolveDittoApiBaseUrl({ stored: "https://evil.example.test", configured: undefined }),
    ).toBe(DITTO_PRODUCTION_API_BASE_URL);
  });
});
