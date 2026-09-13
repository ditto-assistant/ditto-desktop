/**
 * DittoAccountService — the Ditto account this environment is linked to.
 *
 * The server drives the device-code flow itself: it asks the Ditto API for a
 * code, polls the token endpoint, and ends up with a long-lived `ditto_mcp_`
 * key. Doing this server-side keeps the browser origin out of the requests
 * (no CORS) and keeps the credential in the server's secret store (one
 * encrypted file under the T3 home) rather than renderer storage; the client
 * only ever sees a hint. Teleport reads the credential here to talk to the
 * Ditto API.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  DittoAccountError,
  type DittoAccountStatus,
  type DittoDeviceLinkChallenge,
  type DittoDeviceLinkPoll,
  type DittoDeviceLinkPollInput,
  type DittoDeviceLinkStartInput,
} from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  DEVICE_CODE_GRANT_TYPE,
  DEVICE_CODE_ROUTE,
  DEVICE_TOKEN_ROUTE,
  interpretDeviceTokenResponse,
  parseDeviceCodeGrant,
  parseJsonBody,
} from "./deviceCode.ts";

const SECRET_NAME = "ditto-account";

const StoredDittoAccount = Schema.Struct({
  apiKey: Schema.String,
  apiBaseUrl: Schema.String,
  linkedAt: Schema.String,
});
type StoredDittoAccount = typeof StoredDittoAccount.Type;

const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredDittoAccount));
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredDittoAccount));

export interface DittoAccountCredentials {
  readonly apiKey: string;
  readonly apiBaseUrl: string;
}

/** Last four characters, the same hint the Ditto app shows for a key. */
function dittoKeyHint(apiKey: string): string {
  return apiKey.length <= 4 ? apiKey : apiKey.slice(-4);
}

function normalizeDittoApiBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return null;
  }
  return url.origin;
}

export class DittoAccountService extends Context.Service<
  DittoAccountService,
  {
    readonly status: Effect.Effect<DittoAccountStatus, DittoAccountError>;
    readonly link: (input: {
      readonly apiKey: string;
      readonly apiBaseUrl: string;
    }) => Effect.Effect<DittoAccountStatus, DittoAccountError>;
    readonly unlink: Effect.Effect<DittoAccountStatus, DittoAccountError>;
    /** The stored credentials, when linked. */
    readonly credentials: Effect.Effect<Option.Option<DittoAccountCredentials>, DittoAccountError>;
    /** Asks Ditto for a device code; the client shows `userCode` and opens `verificationUrl`. */
    readonly startDeviceLink: (
      input: DittoDeviceLinkStartInput,
    ) => Effect.Effect<DittoDeviceLinkChallenge, DittoAccountError>;
    /** One token-endpoint poll; stores the key and reports `linked` once approved. */
    readonly pollDeviceLink: (
      input: DittoDeviceLinkPollInput,
    ) => Effect.Effect<DittoDeviceLinkPoll, DittoAccountError>;
  }
>()("t3/teleport/DittoAccount/DittoAccountService") {}

interface PendingDeviceLink {
  readonly deviceCode: string;
  readonly apiBaseUrl: string;
  readonly expiresAtMs: number;
}

function describeCause(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(cause);
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  // Attempts in flight, keyed by the opaque id the client polls with. The
  // device code itself stays here so it never crosses the wire to a renderer.
  const pending = new Map<string, PendingDeviceLink>();
  // Handles are opaque, not secret: only an authenticated client with operate
  // scope can poll, and each handle resolves once. A counter is enough.
  let linkSequence = 0;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const fail = (message: string) => new DittoAccountError({ message });

  const read: Effect.Effect<Option.Option<StoredDittoAccount>, DittoAccountError> = secrets
    .get(SECRET_NAME)
    .pipe(
      Effect.mapError(() => fail("Could not read the linked Ditto account.")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<StoredDittoAccount>()),
          onSome: (bytes) =>
            decodeStored(decoder.decode(bytes)).pipe(
              Effect.map(Option.some),
              // A corrupt file means "not linked" rather than a dead settings page.
              Effect.orElseSucceed(() => Option.none<StoredDittoAccount>()),
            ),
        }),
      ),
    );

  const toStatus = (stored: Option.Option<StoredDittoAccount>): DittoAccountStatus =>
    Option.match(stored, {
      onNone: () => ({ linked: false }),
      onSome: (account) => ({
        linked: true,
        keyHint: dittoKeyHint(account.apiKey),
        apiBaseUrl: account.apiBaseUrl,
      }),
    });

  const status = read.pipe(Effect.map(toStatus));

  const link: DittoAccountService["Service"]["link"] = Effect.fn("DittoAccountService.link")(
    function* (input) {
      const apiKey = input.apiKey.trim();
      if (!apiKey.startsWith("ditto_mcp_")) {
        return yield* fail(
          "That is not a Ditto key. Finish the device-code sign-in and try again.",
        );
      }
      const apiBaseUrl = normalizeDittoApiBaseUrl(input.apiBaseUrl);
      if (apiBaseUrl === null) {
        return yield* fail("The Ditto API base URL must be an https origin.");
      }
      const stored: StoredDittoAccount = {
        apiKey,
        apiBaseUrl,
        linkedAt: DateTime.formatIso(yield* DateTime.now),
      };
      const json = yield* encodeStored(stored).pipe(
        Effect.mapError(() => fail("Could not encode the Ditto account.")),
      );
      yield* secrets
        .set(SECRET_NAME, encoder.encode(json))
        .pipe(Effect.mapError(() => fail("Could not store the Ditto account securely.")));
      return toStatus(Option.some(stored));
    },
  );

  const unlink = secrets.remove(SECRET_NAME).pipe(
    Effect.mapError(() => fail("Could not remove the linked Ditto account.")),
    Effect.as<DittoAccountStatus>({ linked: false }),
  );

  const credentials = read.pipe(
    Effect.map(
      Option.map((account): DittoAccountCredentials => ({
        apiKey: account.apiKey,
        apiBaseUrl: account.apiBaseUrl,
      })),
    ),
  );

  /** Anonymous JSON POST to the Ditto API; 4xx bodies are returned, not failed, because the token endpoint speaks through them. */
  const postAnonymous = (apiBaseUrl: string, route: string, body: unknown) =>
    Effect.gen(function* () {
      const request = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post(`${apiBaseUrl}${route}`),
        body,
      ).pipe(Effect.mapError(() => fail(`Could not encode the request for ${route}.`)));
      const response = yield* httpClient
        .execute(request.pipe(HttpClientRequest.setHeader("X-Platform", "desktop")))
        .pipe(
          Effect.mapError((cause) =>
            fail(`Could not reach Ditto (${route}): ${describeCause(cause)}`),
          ),
        );
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return { status: response.status, body: parseJsonBody(text) };
    });

  const startDeviceLink: DittoAccountService["Service"]["startDeviceLink"] = Effect.fn(
    "DittoAccountService.startDeviceLink",
  )(function* (input) {
    const apiBaseUrl = normalizeDittoApiBaseUrl(input.apiBaseUrl);
    if (apiBaseUrl === null) {
      return yield* fail("The Ditto API base URL must be an https origin.");
    }
    const { status: httpStatus, body } = yield* postAnonymous(apiBaseUrl, DEVICE_CODE_ROUTE, {});
    const grant = parseDeviceCodeGrant(body);
    if (httpStatus >= 400 || grant === null) {
      return yield* fail(`Ditto did not return a device code (HTTP ${httpStatus}).`);
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const expiresAtMs = nowMs + grant.expiresInSeconds * 1000;
    linkSequence += 1;
    const linkId = `link-${nowMs.toString(36)}-${linkSequence}`;
    pending.set(linkId, { deviceCode: grant.deviceCode, apiBaseUrl, expiresAtMs });
    return {
      linkId,
      userCode: grant.userCode,
      verificationUrl: grant.verificationUrl,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs)),
      intervalSeconds: grant.intervalSeconds,
    };
  });

  const pollDeviceLink: DittoAccountService["Service"]["pollDeviceLink"] = Effect.fn(
    "DittoAccountService.pollDeviceLink",
  )(function* (input) {
    const attempt = pending.get(input.linkId);
    if (attempt === undefined) {
      return yield* fail("This link attempt is no longer active. Start again.");
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs >= attempt.expiresAtMs) {
      pending.delete(input.linkId);
      return { kind: "expired" } as const;
    }
    const { body } = yield* postAnonymous(attempt.apiBaseUrl, DEVICE_TOKEN_ROUTE, {
      device_code: attempt.deviceCode,
      grant_type: DEVICE_CODE_GRANT_TYPE,
    });
    const outcome = interpretDeviceTokenResponse(body);
    switch (outcome.kind) {
      case "pending":
        return { kind: "pending" } as const;
      case "slow-down":
        return { kind: "slow-down" } as const;
      case "expired":
        pending.delete(input.linkId);
        return { kind: "expired" } as const;
      case "denied":
        pending.delete(input.linkId);
        return { kind: "denied" } as const;
      case "error":
        pending.delete(input.linkId);
        return yield* fail(outcome.message);
      case "approved": {
        pending.delete(input.linkId);
        const linked = yield* link({ apiKey: outcome.accessToken, apiBaseUrl: attempt.apiBaseUrl });
        return { kind: "linked", status: linked } as const;
      }
    }
  });

  return DittoAccountService.of({
    status,
    link,
    unlink,
    credentials,
    startDeviceLink,
    pollDeviceLink,
  });
});

export const layer = Layer.effect(DittoAccountService, make);
