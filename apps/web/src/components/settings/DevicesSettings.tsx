/**
 * Devices settings — the machines signed into this Ditto account, this
 * machine's own host identity, and the pairing flow that links two of them
 * so each can drive the other's sessions.
 *
 * Pairing works like Codex desktop: both machines are signed in, one shows a
 * six-digit code, the other types it. Control between paired devices always
 * goes through the Ditto backend's session turn API, never peer-to-peer.
 *
 * @module DevicesSettings
 */
import { useNavigate } from "@tanstack/react-router";
import {
  KeyRoundIcon,
  LaptopIcon,
  MonitorSmartphoneIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { getDittoDeviceId } from "~/ditto/api";
import { getDittoApiBaseUrl } from "~/ditto/apiBase";
import { isDittoCloudConfigured } from "~/ditto/config";
import {
  describeHostKind,
  describeHostPresence,
  formatPairingCode,
  isCompletePairingCode,
  normalizePairingCodeInput,
  pairingSecondsRemaining,
  partitionDittoHosts,
  sortHostSessions,
} from "~/ditto/devices.logic";
import type { DittoUser } from "~/ditto/firebase";
import {
  claimDittoPairing,
  createDittoPairing,
  useDittoHosts,
  type DittoHost,
  type DittoPairing,
} from "~/ditto/hosts";
import { pairedHostRegistration } from "~/ditto/pairedEnvironments";
import { useDittoUser } from "~/ditto/useDittoUser";
import { environmentCatalog } from "~/connection/catalog";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function PresenceBadge({ host, now }: { readonly host: DittoHost; readonly now: number }) {
  return (
    <Badge variant={host.presence === "online" ? "success" : "outline"} size="sm">
      {describeHostPresence(host.presence, host.lastSeenAt, now)}
    </Badge>
  );
}

function ThisDeviceRow({ self }: { readonly self: DittoHost | null }) {
  const now = useNow(30_000);
  const deviceId = getDittoDeviceId();
  return (
    <SettingsRow
      {...searchableSetting("ditto-this-device")}
      description={
        self === null ? (
          <>
            This machine has not announced itself as a host yet. Host mode starts when the desktop
            server connects to Ditto with its device-link key.
          </>
        ) : (
          <>
            {describeHostKind(self)}
            {self.version ? ` · v${self.version}` : ""}
          </>
        )
      }
      control={self === null ? null : <PresenceBadge host={self} now={now} />}
    >
      <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <KeyRoundIcon className="size-3.5" />
        <span>device {deviceId}</span>
        {self !== null ? <span>· host {self.id}</span> : null}
      </div>
    </SettingsRow>
  );
}

function HostSessions({ host }: { readonly host: DittoHost }) {
  const navigate = useNavigate();
  const sessions = useMemo(() => sortHostSessions(host.sessions), [host.sessions]);
  if (sessions.length === 0) {
    return <p className="text-xs text-muted-foreground">No sessions announced.</p>;
  }
  return (
    <ul className="grid gap-1">
      {sessions.map((session) => (
        <li key={session.sessionId} className="flex items-center gap-2 text-xs">
          <Badge variant={session.status === "running" ? "info" : "outline"} size="sm">
            {session.status}
          </Badge>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-foreground">{session.title ?? session.cwd}</span>
            <span className="text-muted-foreground">
              {" "}
              · {session.harness} · {session.mode}
            </span>
          </span>
          <Button
            type="button"
            size="compact"
            variant="outline"
            disabled={host.presence !== "online"}
            onClick={() =>
              void navigate({
                to: "/remote/$hostId/$threadId",
                params: { hostId: host.id, threadId: session.threadId },
              })
            }
          >
            Open
          </Button>
        </li>
      ))}
    </ul>
  );
}

function PairedHostRow({
  host,
  user,
  now,
}: {
  readonly host: DittoHost;
  readonly user: DittoUser;
  readonly now: number;
}) {
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState(false);
  const addAsEnvironment = useCallback(async () => {
    setRegistering(true);
    try {
      const bearerToken = await user.getIdToken();
      await registerEnvironment(
        pairedHostRegistration({ host, apiBaseUrl: getDittoApiBaseUrl(), bearerToken }),
      );
      setRegistered(true);
    } finally {
      setRegistering(false);
    }
  }, [host, registerEnvironment, user]);

  return (
    <SettingsRow
      id={`ditto-host-${host.id}`}
      title={host.name}
      description={describeHostKind(host)}
      control={
        <div className="flex items-center gap-2">
          <PresenceBadge host={host} now={now} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={registering || registered}
            onClick={() => void addAsEnvironment()}
          >
            {registered ? "Added" : "Add as environment"}
          </Button>
        </div>
      }
    >
      <HostSessions host={host} />
    </SettingsRow>
  );
}

function UnpairedHostRow({ host, now }: { readonly host: DittoHost; readonly now: number }) {
  return (
    <SettingsRow
      id={`ditto-host-${host.id}`}
      title={host.name}
      description={`${describeHostKind(host)} · not paired with this machine`}
      control={<PresenceBadge host={host} now={now} />}
    />
  );
}

function ShowPairingCode({
  user,
  onPaired,
}: {
  readonly user: DittoUser;
  readonly onPaired: () => void;
}) {
  const [pairing, setPairing] = useState<DittoPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(1_000);
  const remaining = pairing === null ? 0 : pairingSecondsRemaining(pairing, now);

  const request = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setPairing(await createDittoPairing(user));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [user]);

  useEffect(() => {
    if (pairing !== null && remaining === 0) setPairing(null);
  }, [pairing, remaining]);

  // The claim lands on the backend; refresh the host list so the pair shows up.
  useEffect(() => {
    if (pairing === null) return;
    const timer = setInterval(onPaired, 5_000);
    return () => clearInterval(timer);
  }, [pairing, onPaired]);

  return (
    <div className="grid gap-2">
      {pairing === null ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void request()}
        >
          {busy ? <Spinner /> : <PlusIcon className="size-3.5" />}
          Show pairing code
        </Button>
      ) : (
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-2xl tracking-widest text-foreground"
            data-testid="pairing-code"
          >
            {formatPairingCode(pairing.code)}
          </span>
          <span className="text-xs text-muted-foreground">expires in {remaining}s</span>
        </div>
      )}
      {error !== null ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </div>
  );
}

function EnterPairingCode({
  user,
  onPaired,
}: {
  readonly user: DittoUser;
  readonly onPaired: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedWith, setPairedWith] = useState<string | null>(null);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!isCompletePairingCode(code)) return;
      setBusy(true);
      setError(null);
      try {
        const host = await claimDittoPairing(user, normalizePairingCodeInput(code));
        setPairedWith(host.name);
        setCode("");
        onPaired();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [code, onPaired, user],
  );

  return (
    <form className="grid gap-2" onSubmit={(event) => void submit(event)}>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Pairing code"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123 456"
          className="w-32 font-mono tracking-widest"
          value={formatPairingCode(code)}
          onChange={(event) => setCode(normalizePairingCodeInput(event.target.value))}
        />
        <Button type="submit" size="sm" disabled={busy || !isCompletePairingCode(code)}>
          {busy ? <Spinner /> : null}
          Pair
        </Button>
      </div>
      {pairedWith !== null ? (
        <p className="text-xs text-success-foreground">Paired with {pairedWith}.</p>
      ) : null}
      {error !== null ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
    </form>
  );
}

function DevicesBody({ user }: { readonly user: DittoUser }) {
  const { hosts, loading, error, refresh } = useDittoHosts(user);
  const now = useNow(30_000);
  const partitioned = useMemo(() => partitionDittoHosts(hosts, getDittoDeviceId()), [hosts]);
  const onPaired = useCallback(() => void refresh(), [refresh]);

  return (
    <>
      <SettingsSection
        title="Devices"
        icon={<MonitorSmartphoneIcon className="size-4" />}
        headerAction={
          <Button type="button" size="compact" variant="ghost" onClick={() => void refresh()}>
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </Button>
        }
      >
        <ThisDeviceRow self={partitioned.self} />
        {loading ? (
          <SettingsRow id="ditto-devices-loading" title="Loading devices…" control={<Spinner />} />
        ) : null}
        {error !== null ? (
          <SettingsRow
            id="ditto-devices-error"
            title="Could not load devices"
            description={error}
          />
        ) : null}
        {partitioned.paired.map((host) => (
          <PairedHostRow key={host.id} host={host} user={user} now={now} />
        ))}
        {partitioned.others.map((host) => (
          <UnpairedHostRow key={host.id} host={host} now={now} />
        ))}
        {!loading && error === null && hosts.length === 0 ? (
          <SettingsRow
            id="ditto-devices-empty"
            title="No devices yet"
            description="Sign in on another machine running Ditto Desktop or the heyditto CLI and it will show up here."
          />
        ) : null}
      </SettingsSection>
      <SettingsSection title="Pair another device" icon={<LaptopIcon className="size-4" />}>
        <SettingsRow
          {...searchableSetting("ditto-pair-device")}
          description="Show this code on this machine, then enter it on the other one. Both need to be signed in to the same Ditto account. Once paired, each device can open the other's sessions."
        >
          <ShowPairingCode user={user} onPaired={onPaired} />
        </SettingsRow>
        <SettingsRow
          id="ditto-pair-enter-code"
          title="Enter a code from another device"
          description="Type the six digits shown on the other machine."
        >
          <EnterPairingCode user={user} onPaired={onPaired} />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}

export function DevicesSettingsPanel() {
  const { ready, user } = useDittoUser();
  const configured = isDittoCloudConfigured();
  return (
    <SettingsPageContainer>
      {!configured ? (
        <SettingsSection title="Devices" icon={<MonitorSmartphoneIcon className="size-4" />}>
          <SettingsRow
            {...searchableSetting("ditto-this-device")}
            description="Ditto cloud is not configured in this build, so devices cannot be listed."
          />
        </SettingsSection>
      ) : !ready ? (
        <SettingsSection title="Devices" icon={<MonitorSmartphoneIcon className="size-4" />}>
          <SettingsRow
            {...searchableSetting("ditto-this-device")}
            description="Checking your Ditto session…"
            control={<Spinner />}
          />
        </SettingsSection>
      ) : user === null ? (
        <SettingsSection title="Devices" icon={<MonitorSmartphoneIcon className="size-4" />}>
          <SettingsRow
            {...searchableSetting("ditto-this-device")}
            description="Sign in with your Ditto account (Settings → Ditto Account) to see the devices signed into it and pair this machine with another."
          />
        </SettingsSection>
      ) : (
        <DevicesBody user={user} />
      )}
    </SettingsPageContainer>
  );
}
