import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { DittoAccountService, layer as dittoAccountLayer } from "./DittoAccount.ts";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly platform: string | undefined;
  readonly body: unknown;
}

interface ScriptedResponse {
  readonly status: number;
  readonly body: unknown;
}

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** An HttpClient that answers from a queue and records what it was asked. */
function scriptedHttp(responses: ScriptedResponse[], recorded: RecordedRequest[]) {
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const bodyText =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      recorded.push({
        method: request.method,
        url: request.url,
        platform: request.headers["x-platform"],
        body: bodyText.length > 0 ? decodeJson(bodyText) : null,
      });
      const next = responses.shift();
      if (next === undefined) {
        return yield* Effect.die(`no scripted response for ${request.method} ${request.url}`);
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(encodeJson(next.body), {
          status: next.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return Layer.succeed(HttpClient.HttpClient, client);
}

function memorySecrets() {
  const store = new Map<string, Uint8Array>();
  const layer = Layer.mock(ServerSecretStore)({
    // Lazy on purpose: the service builds its `read` effect once and re-runs it.
    get: (name) => Effect.sync(() => Option.fromNullishOr(store.get(name))),
    set: (name, value) => Effect.sync(() => void store.set(name, value)),
    create: (name, value) => Effect.sync(() => void store.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = store.get(name);
        if (existing) return existing;
        const fresh = new Uint8Array(bytes);
        store.set(name, fresh);
        return fresh;
      }),
    remove: (name) => Effect.sync(() => void store.delete(name)),
  });
  return { layer, store };
}

function liveAccount(responses: ScriptedResponse[], recorded: RecordedRequest[] = []) {
  const secrets = memorySecrets();
  const layer = dittoAccountLayer.pipe(
    Layer.provide(Layer.merge(secrets.layer, scriptedHttp(responses, recorded))),
  );
  return { layer, store: secrets.store };
}

const GRANT = {
  device_code: "dev-secret-1",
  user_code: "ABCD-1234",
  verification_url: "https://heyditto.ai/device",
  expires_in: 600,
  interval: 5,
};

describe("DittoAccountService device link", () => {
  it.effect("starts a link, polls until approval, and stores the key server-side", () => {
    const recorded: RecordedRequest[] = [];
    const live = liveAccount(
      [
        { status: 200, body: GRANT },
        { status: 400, body: { error: "authorization_pending" } },
        { status: 400, body: { error: "slow_down" } },
        { status: 200, body: { access_token: "ditto_mcp_abcdefgh12345678" } },
      ],
      recorded,
    );
    return Effect.gen(function* () {
      const account = yield* DittoAccountService;
      const challenge = yield* account.startDeviceLink({
        apiBaseUrl: "https://pr-2547-api.heyditto.ai/",
      });
      const polls = [];
      for (let i = 0; i < 3; i += 1) {
        polls.push(yield* account.pollDeviceLink({ linkId: challenge.linkId }));
      }
      const status = yield* account.status;
      const credentials = yield* account.credentials;
      const afterwards = yield* account
        .pollDeviceLink({ linkId: challenge.linkId })
        .pipe(Effect.result);

      expect(challenge).toMatchObject({
        userCode: "ABCD-1234",
        verificationUrl: "https://heyditto.ai/device",
        intervalSeconds: 5,
      });
      expect(challenge).not.toHaveProperty("deviceCode");
      // it.effect runs on the TestClock at epoch 0, so 600s lands at 00:10.
      expect(challenge.expiresAt).toBe("1970-01-01T00:10:00.000Z");

      expect(polls.map((poll) => poll.kind)).toEqual(["pending", "slow-down", "linked"]);
      expect(status).toEqual({
        linked: true,
        keyHint: "5678",
        apiBaseUrl: "https://pr-2547-api.heyditto.ai",
      });
      expect(Option.getOrThrow(credentials)).toEqual({
        apiKey: "ditto_mcp_abcdefgh12345678",
        apiBaseUrl: "https://pr-2547-api.heyditto.ai",
      });
      expect(live.store.has("ditto-account")).toBe(true);

      // The attempt is single-use once it resolves.
      expect(afterwards._tag).toBe("Failure");

      expect(recorded.map((r) => [r.method, r.url])).toEqual([
        ["POST", "https://pr-2547-api.heyditto.ai/api/v2/mcp/device-code"],
        ["POST", "https://pr-2547-api.heyditto.ai/api/v2/mcp/device-token"],
        ["POST", "https://pr-2547-api.heyditto.ai/api/v2/mcp/device-token"],
        ["POST", "https://pr-2547-api.heyditto.ai/api/v2/mcp/device-token"],
      ]);
      expect(recorded.every((r) => r.platform === "desktop")).toBe(true);
      expect(recorded[1]?.body).toEqual({
        device_code: "dev-secret-1",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
    }).pipe(Effect.provide(live.layer));
  });

  it.effect("reports denial and expiry without storing anything", () => {
    const live = liveAccount([
      { status: 200, body: GRANT },
      { status: 400, body: { error: "access_denied" } },
      { status: 200, body: { ...GRANT, expires_in: 0 } },
    ]);
    return Effect.gen(function* () {
      const account = yield* DittoAccountService;
      const first = yield* account.startDeviceLink({ apiBaseUrl: "https://api.heyditto.ai" });
      const denied = yield* account.pollDeviceLink({ linkId: first.linkId });
      const second = yield* account.startDeviceLink({ apiBaseUrl: "https://api.heyditto.ai" });
      const expired = yield* account.pollDeviceLink({ linkId: second.linkId });
      const status = yield* account.status;

      expect(denied.kind).toBe("denied");
      expect(expired.kind).toBe("expired");
      expect(status).toEqual({ linked: false });
      expect(live.store.size).toBe(0);
    }).pipe(Effect.provide(live.layer));
  });

  it.effect("refuses a non-https API base and a missing grant", () => {
    const live = liveAccount([{ status: 500, body: { error: "boom" } }]);
    return Effect.gen(function* () {
      const account = yield* DittoAccountService;
      const badBase = yield* account
        .startDeviceLink({ apiBaseUrl: "http://evil.test" })
        .pipe(Effect.result);
      const noGrant = yield* account
        .startDeviceLink({ apiBaseUrl: "https://api.heyditto.ai" })
        .pipe(Effect.result);

      expect(badBase._tag).toBe("Failure");
      expect(noGrant._tag).toBe("Failure");
    }).pipe(Effect.provide(live.layer));
  });
});
