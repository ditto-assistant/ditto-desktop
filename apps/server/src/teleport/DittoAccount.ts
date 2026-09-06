/**
 * DittoAccountService — the Ditto account this environment is linked to.
 *
 * The device-code flow in the client ends with a long-lived `ditto_mcp_` key.
 * That key is a credential, so it lives in the server's secret store (one
 * encrypted file under the T3 home) rather than renderer storage, and the
 * client only ever sees a hint. Teleport reads the credential here to talk to
 * the Ditto API.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DittoAccountError, type DittoAccountStatus } from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

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
export function dittoKeyHint(apiKey: string): string {
  return apiKey.length <= 4 ? apiKey : apiKey.slice(-4);
}

export function normalizeDittoApiBaseUrl(value: string): string | null {
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
  }
>()("t3/teleport/DittoAccount/DittoAccountService") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
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
      Option.map(
        (account): DittoAccountCredentials => ({
          apiKey: account.apiKey,
          apiBaseUrl: account.apiBaseUrl,
        }),
      ),
    ),
  );

  return DittoAccountService.of({ status, link, unlink, credentials });
});

export const layer = Layer.effect(DittoAccountService, make);
