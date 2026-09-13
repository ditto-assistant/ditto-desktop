/**
 * Pure helpers behind the Devices settings section and the pairing flow.
 *
 * @module ditto/devices.logic
 */
import type { DittoHost, DittoHostPresence, DittoPairing } from "./hosts";

const PAIRING_CODE_LENGTH = 6;

export interface PartitionedDittoHosts {
  /** The host record for this machine, matched by device id. */
  readonly self: DittoHost | null;
  /** Hosts that completed a pairing with this machine. */
  readonly paired: ReadonlyArray<DittoHost>;
  /** Signed-in devices that are not paired with this machine yet. */
  readonly others: ReadonlyArray<DittoHost>;
}

function byPresenceThenName(left: DittoHost, right: DittoHost): number {
  if (left.presence !== right.presence) return left.presence === "online" ? -1 : 1;
  return left.name.localeCompare(right.name);
}

export function partitionDittoHosts(
  hosts: ReadonlyArray<DittoHost>,
  ownDeviceId: string,
): PartitionedDittoHosts {
  const self = hosts.find((host) => host.deviceId === ownDeviceId) ?? null;
  const paired: DittoHost[] = [];
  const others: DittoHost[] = [];
  for (const host of hosts) {
    if (host === self) continue;
    const pairedWithSelf =
      self !== null &&
      (self.pairedHostIds.includes(host.id) || host.pairedHostIds.includes(self.id));
    (pairedWithSelf ? paired : others).push(host);
  }
  return {
    self,
    paired: paired.toSorted(byPresenceThenName),
    others: others.toSorted(byPresenceThenName),
  };
}

/** Keeps only digits and caps the length; what the code input accepts while typing. */
export function normalizePairingCodeInput(value: string): string {
  return value.replace(/\D+/g, "").slice(0, PAIRING_CODE_LENGTH);
}

export function isCompletePairingCode(value: string): boolean {
  return normalizePairingCodeInput(value).length === PAIRING_CODE_LENGTH;
}

/** `123456` → `123 456` for display. */
export function formatPairingCode(code: string): string {
  const digits = normalizePairingCodeInput(code);
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function pairingSecondsRemaining(pairing: DittoPairing, now: number): number {
  const expiresAt = Date.parse(pairing.expiresAt);
  if (Number.isNaN(expiresAt)) return 0;
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function describeHostPresence(
  presence: DittoHostPresence,
  lastSeenAt: string | null,
  now: number,
): string {
  if (presence === "online") return "Online";
  if (lastSeenAt === null) return "Offline";
  const seenAt = Date.parse(lastSeenAt);
  if (Number.isNaN(seenAt)) return "Offline";
  const minutes = Math.max(0, Math.round((now - seenAt) / 60_000));
  if (minutes < 1) return "Offline · seen just now";
  if (minutes < 60) return `Offline · seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Offline · seen ${hours} h ago`;
  return `Offline · seen ${Math.round(hours / 24)} d ago`;
}

export function describeHostKind(host: Pick<DittoHost, "kind" | "platform">): string {
  const kind =
    host.kind === "desktop"
      ? "Ditto Desktop"
      : host.kind === "cli"
        ? "heyditto CLI"
        : host.kind === "mobile"
          ? "Ditto mobile"
          : "Ditto web";
  return host.platform ? `${kind} · ${host.platform}` : kind;
}

/** Session rows in a stable order: running first, then by title/cwd. */
export function sortHostSessions(
  sessions: ReadonlyArray<DittoHost["sessions"][number]>,
): ReadonlyArray<DittoHost["sessions"][number]> {
  return sessions.toSorted((left, right) => {
    if (left.status !== right.status) return left.status === "running" ? -1 : 1;
    return (left.title ?? left.cwd).localeCompare(right.title ?? right.cwd);
  });
}
