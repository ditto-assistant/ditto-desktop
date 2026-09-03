/**
 * The Ditto chat-connector API, as far as Google Messages pairing needs it.
 *
 * Same endpoints ditto-app calls; the desktop only adds the Google sign-in
 * that produces the cookies. Responses are decoded with Effect Schema so a
 * backend that adds fields keeps working and one that changes shape fails
 * loudly.
 *
 * @module ditto/googleMessages
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { dittoFetchJson } from "./api";
import type { DittoUser } from "./firebase";

export const GOOGLE_MESSAGES_PROVIDER = "googlemessages";

const ConnectionSchema = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  displayName: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.String,
  messageCount: Schema.optional(Schema.NullOr(Schema.Number)),
  lastSyncedAt: Schema.optional(Schema.NullOr(Schema.String)),
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
});
export type DittoConnection = typeof ConnectionSchema.Type;

const ConnectionListSchema = Schema.Struct({
  connections: Schema.optional(Schema.NullOr(Schema.Array(ConnectionSchema))),
});

const ChallengeSchema = Schema.Struct({
  field: Schema.String,
  kind: Schema.String,
  prompt: Schema.String,
  state: Schema.String,
});

const ConnectOutcomeSchema = Schema.Struct({
  connection: Schema.optional(Schema.NullOr(ConnectionSchema)),
  challenge: Schema.optional(Schema.NullOr(ChallengeSchema)),
});
export type DittoConnectOutcome = typeof ConnectOutcomeSchema.Type;

const decodeConnectionList = Schema.decodeUnknownEffect(ConnectionListSchema);
const decodeConnectOutcome = Schema.decodeUnknownEffect(ConnectOutcomeSchema);

export async function listDittoConnections(user: DittoUser): Promise<readonly DittoConnection[]> {
  const body = await dittoFetchJson<unknown>(user, "/api/v5/users/{uid}/connections");
  const decoded = await Effect.runPromise(decodeConnectionList(body));
  return decoded.connections ?? [];
}

export async function findGoogleMessagesConnection(
  user: DittoUser,
): Promise<DittoConnection | null> {
  const connections = await listDittoConnections(user);
  return connections.find((connection) => connection.provider === GOOGLE_MESSAGES_PROVIDER) ?? null;
}

/** One round of the connect flow: the initial cookies, or a poll of a pairing wait. */
export async function connectGoogleMessages(
  user: DittoUser,
  credentials: Readonly<Record<string, string>>,
): Promise<DittoConnectOutcome> {
  const body = await dittoFetchJson<unknown>(
    user,
    `/api/v5/users/{uid}/connectors/${GOOGLE_MESSAGES_PROVIDER}/connect`,
    { method: "POST", body: credentials },
  );
  return Effect.runPromise(decodeConnectOutcome(body));
}

export async function disconnectDittoConnection(user: DittoUser, id: string): Promise<void> {
  await dittoFetchJson<unknown>(user, `/api/v5/users/{uid}/connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function syncDittoConnection(user: DittoUser, id: string): Promise<void> {
  await dittoFetchJson<unknown>(
    user,
    `/api/v5/users/{uid}/connections/${encodeURIComponent(id)}/sync`,
    { method: "POST" },
  );
}
