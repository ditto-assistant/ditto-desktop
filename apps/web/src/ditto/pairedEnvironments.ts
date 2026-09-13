/**
 * A paired Ditto host as an entry in t3code's environment registry.
 *
 * The registry drives the environment switcher, so registering a paired host
 * makes it show up next to SSH/relay environments. The connection is routed
 * through the Ditto backend's host proxy (never peer-to-peer):
 * `<api>/api/v5/hosts/{hostId}/env` speaks the same RPC surface as a local
 * t3code server, authenticated with the account's bearer token.
 *
 * @module ditto/pairedEnvironments
 */
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";

import type { DittoHost } from "./hosts";

function pairedHostEnvironmentId(host: Pick<DittoHost, "id">): EnvironmentId {
  return EnvironmentId.make(`ditto-host:${host.id}`);
}

function pairedHostProxyBaseUrl(apiBaseUrl: string, host: Pick<DittoHost, "id">): string {
  return `${apiBaseUrl.replace(/\/+$/, "")}/api/v5/hosts/${encodeURIComponent(host.id)}/env`;
}

export function pairedHostRegistration(input: {
  readonly host: Pick<DittoHost, "id" | "name">;
  readonly apiBaseUrl: string;
  readonly bearerToken: string;
}): BearerConnectionRegistration {
  const environmentId = pairedHostEnvironmentId(input.host);
  const connectionId = `ditto-host:${input.host.id}`;
  const httpBaseUrl = pairedHostProxyBaseUrl(input.apiBaseUrl, input.host);
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({ environmentId, label: input.host.name, connectionId }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId,
      label: input.host.name,
      httpBaseUrl,
      wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
    }),
    credential: new BearerConnectionCredential({ token: input.bearerToken }),
  });
}
