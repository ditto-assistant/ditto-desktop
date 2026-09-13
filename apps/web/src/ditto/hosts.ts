/**
 * Ditto hosts: the devices signed into the Ditto account, their presence, the
 * sessions they announce, and the pairing handshake between two of them.
 *
 * Backend contract (host bridge protocol v1, `DITTO-TEMPORAL-SESSION-FABRIC.md`):
 *
 * - `GET  /api/v5/hosts`                 → `{ hosts: DittoHost[] }`
 * - `POST /api/v5/hosts/pairings`        → `{ code, expiresAt }` (this machine shows the code)
 * - `POST /api/v5/hosts/pairings/claim`  → `{ host }` (the other machine enters it)
 *
 * Control never goes peer-to-peer: a paired device's sessions are driven through
 * the backend's session turn API (see `remoteSessions.ts`).
 *
 * @module ditto/hosts
 */
import { useCallback, useEffect, useState } from "react";

import { dittoFetchJson, getDittoDeviceId } from "./api";
import type { DittoUser } from "./firebase";

export type DittoHostKind = "desktop" | "cli" | "mobile" | "web";
export type DittoHostPresence = "online" | "offline";
export type DittoHarness = "claude-code" | "codex";
export type DittoSessionMode = "tui" | "headless";
export type DittoSessionStatus = "idle" | "running";

export interface DittoHostSession {
  readonly sessionId: string;
  /** The Ditto session thread id used by `/api/v5/sessions/{threadId}`. */
  readonly threadId: string;
  readonly harness: DittoHarness;
  readonly cwd: string;
  readonly mode: DittoSessionMode;
  readonly status: DittoSessionStatus;
  readonly title?: string | undefined;
}

export interface DittoHost {
  readonly id: string;
  readonly kind: DittoHostKind;
  readonly name: string;
  readonly platform?: string | undefined;
  readonly version?: string | undefined;
  /** The `X-Device-ID` the host authenticates with; matches `getDittoDeviceId()` for this machine. */
  readonly deviceId?: string | undefined;
  readonly presence: DittoHostPresence;
  readonly lastSeenAt: string | null;
  /** Host ids this host has completed a pairing with. */
  readonly pairedHostIds: ReadonlyArray<string>;
  readonly sessions: ReadonlyArray<DittoHostSession>;
}

export interface DittoPairing {
  readonly code: string;
  readonly expiresAt: string;
}

async function listDittoHosts(user: DittoUser): Promise<ReadonlyArray<DittoHost>> {
  const body = await dittoFetchJson<{ readonly hosts?: ReadonlyArray<DittoHost> }>(
    user,
    "/api/v5/hosts",
  );
  return body.hosts ?? [];
}

export async function createDittoPairing(user: DittoUser): Promise<DittoPairing> {
  return dittoFetchJson<DittoPairing>(user, "/api/v5/hosts/pairings", {
    method: "POST",
    body: { deviceId: getDittoDeviceId() },
  });
}

export async function claimDittoPairing(user: DittoUser, code: string): Promise<DittoHost> {
  const body = await dittoFetchJson<{ readonly host: DittoHost }>(
    user,
    "/api/v5/hosts/pairings/claim",
    { method: "POST", body: { code, deviceId: getDittoDeviceId() } },
  );
  return body.host;
}

export interface DittoHostsState {
  readonly hosts: ReadonlyArray<DittoHost>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

const HOSTS_POLL_INTERVAL_MS = 15_000;

/** Polls the account's hosts while mounted so presence stays current. */
export function useDittoHosts(user: DittoUser | null): DittoHostsState {
  const [hosts, setHosts] = useState<ReadonlyArray<DittoHost>>([]);
  const [loading, setLoading] = useState(user !== null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (user === null) return;
    try {
      setHosts(await listDittoHosts(user));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (user === null) {
      setHosts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void refresh();
    const timer = setInterval(() => void refresh(), HOSTS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [user, refresh]);

  return { hosts, loading, error, refresh };
}
