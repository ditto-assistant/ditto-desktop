/**
 * Google Messages pairing from the desktop.
 *
 * Runs the phase-one flow against Ditto's hosted bridge: the desktop shell
 * signs the user in to Google in an isolated window and hands back the
 * Google auth cookies; this component posts them to the Ditto backend, shows
 * the pairing emoji the backend returns, and polls until the phone confirms.
 * Once connected, the same connection shows up in the Ditto web app.
 *
 * @module GoogleMessagesConnection
 */
import { MessageSquareIcon, RefreshCwIcon, UnplugIcon } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { DittoApiError } from "~/ditto/api";
import type { DittoUser } from "~/ditto/firebase";
import {
  connectGoogleMessages,
  disconnectDittoConnection,
  findGoogleMessagesConnection,
  syncDittoConnection,
  type DittoConnection,
} from "~/ditto/googleMessages";
import {
  INITIAL_PAIRING_STATE,
  PAIRING_POLL_INTERVAL_MS,
  initialPairingCredentials,
  isPairingWait,
  pollPairingCredentials,
  reducePairing,
} from "~/ditto/googleMessagesPairing.logic";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function describeError(error: unknown): string {
  if (error instanceof DittoApiError) {
    if (error.status === 403) {
      return "Your Ditto account doesn't have Google Messages enabled yet.";
    }
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

function statusBadge(connection: DittoConnection) {
  switch (connection.status) {
    case "active":
      return <Badge variant="success">Connected</Badge>;
    case "pending":
      return <Badge variant="secondary">Pairing</Badge>;
    case "error":
      return <Badge variant="destructive">Needs attention</Badge>;
    default:
      return <Badge variant="outline">{connection.status}</Badge>;
  }
}

export function GoogleMessagesConnectionRow({ user }: { readonly user: DittoUser }) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.googleMessages;
  const [connection, setConnection] = useState<DittoConnection | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"sync" | "disconnect" | null>(null);
  const [pairing, dispatch] = useReducer(reducePairing, INITIAL_PAIRING_STATE);
  // Generation guard: a poll from an abandoned flow must not touch the form.
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setConnection(await findGoogleMessagesConnection(user));
      setLoadError(null);
    } catch (error) {
      setLoadError(describeError(error));
      setConnection(null);
    }
  }, [user]);

  useEffect(() => {
    void refresh();
    return () => {
      generationRef.current += 1;
    };
  }, [refresh]);

  const stop = useCallback(() => {
    generationRef.current += 1;
  }, []);

  const runRound = useCallback(
    async (generation: number, credentials: Readonly<Record<string, string>>) => {
      let outcome;
      try {
        outcome = await connectGoogleMessages(user, credentials);
      } catch (error) {
        if (generation !== generationRef.current) return;
        dispatch({ type: "error", message: describeError(error) });
        return;
      }
      if (generation !== generationRef.current) return;
      const challenge = outcome.challenge ?? null;
      if (challenge !== null) {
        dispatch({ type: "challenge", challenge });
        if (isPairingWait(challenge)) {
          window.setTimeout(() => {
            if (generation !== generationRef.current) return;
            void runRound(generation, pollPairingCredentials(challenge));
          }, PAIRING_POLL_INTERVAL_MS);
        }
        return;
      }
      dispatch({ type: "connected" });
      void refresh();
    },
    [refresh, user],
  );

  const start = useCallback(async () => {
    if (bridge === undefined) return;
    stop();
    const generation = generationRef.current;
    dispatch({ type: "start" });
    const outcome = await bridge.signIn();
    if (generation !== generationRef.current) return;
    if (outcome.status === "cancelled") {
      dispatch({ type: "sign-in-cancelled", reason: outcome.reason });
      return;
    }
    dispatch({ type: "cookies-ready" });
    await runRound(generation, initialPairingCredentials(outcome.cookies));
  }, [bridge, runRound, stop]);

  const cancel = useCallback(() => {
    stop();
    if (pairing.phase === "signing-in") void bridge?.cancelSignIn();
    dispatch({ type: "reset" });
  }, [bridge, pairing.phase, stop]);

  const sync = useCallback(async () => {
    if (connection === null || connection === undefined) return;
    setBusy("sync");
    try {
      await syncDittoConnection(user, connection.id);
      await refresh();
    } catch (error) {
      setLoadError(describeError(error));
    } finally {
      setBusy(null);
    }
  }, [connection, refresh, user]);

  const disconnect = useCallback(async () => {
    if (connection === null || connection === undefined) return;
    setBusy("disconnect");
    try {
      await disconnectDittoConnection(user, connection.id);
      await refresh();
    } catch (error) {
      setLoadError(describeError(error));
    } finally {
      setBusy(null);
    }
  }, [connection, refresh, user]);

  if (bridge === undefined) {
    return (
      <SettingsRow
        {...searchableSetting("google-messages")}
        description="Google Messages pairing needs the Ditto desktop app: it signs you in to Google in a private window so nothing has to be copied by hand."
      />
    );
  }

  if (connection === undefined) {
    return (
      <SettingsRow
        {...searchableSetting("google-messages")}
        description="Checking your Google Messages connection…"
        control={<Spinner />}
      />
    );
  }

  if (connection !== null && pairing.phase !== "waiting" && pairing.phase !== "connecting") {
    return (
      <SettingsRow
        {...searchableSetting("google-messages")}
        description={
          <>
            {connection.displayName || connection.name || "Your Android phone"} ·{" "}
            {connection.messageCount ?? 0} messages synced.
            {connection.lastError ? (
              <span className="block text-destructive">{connection.lastError}</span>
            ) : null}
            {loadError ? <span className="block text-destructive">{loadError}</span> : null}
          </>
        }
        status={statusBadge(connection)}
        control={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void sync()}
            >
              {busy === "sync" ? <Spinner /> : <RefreshCwIcon className="size-3.5" />}
              Sync now
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void disconnect()}
            >
              {busy === "disconnect" ? <Spinner /> : <UnplugIcon className="size-3.5" />}
              Disconnect
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <SettingsRow
      {...searchableSetting("google-messages")}
      description="Pair this Ditto account with the Google Messages app on your Android phone. Ditto signs you in to Google in a private window, your phone shows a pairing emoji to confirm, and your SMS and RCS conversations sync into their own Ditto memory graph."
    >
      <div className="flex w-full flex-col gap-3">
        {pairing.phase === "idle" || pairing.phase === "connected" || pairing.phase === "failed" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" onClick={() => void start()}>
              <MessageSquareIcon className="size-3.5" />
              Connect Google Messages
            </Button>
            {pairing.phase === "failed" ? (
              <p className="text-xs text-destructive" role="alert">
                {pairing.message}
              </p>
            ) : null}
            {loadError ? (
              <p className="text-xs text-destructive" role="alert">
                {loadError}
              </p>
            ) : null}
          </div>
        ) : null}

        {pairing.phase === "signing-in" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Spinner />
            <span className="text-xs text-muted-foreground">
              Sign in to Google in the window that just opened, with the same account as your phone.
            </span>
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        ) : null}

        {pairing.phase === "connecting" ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            Starting pairing…
          </div>
        ) : null}

        {pairing.phase === "waiting" ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-xs text-muted-foreground">
              Google Messages on your phone will ask you to confirm a new device. Tap this emoji
              there to finish pairing.
            </p>
            <span
              role="img"
              aria-label={`Pairing emoji: ${pairing.challenge.prompt}`}
              className="rounded-xl border bg-card px-6 py-4 text-6xl leading-none"
            >
              {pairing.challenge.prompt}
            </span>
            <div className="flex items-center gap-2">
              <span
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                <Spinner />
                Waiting for your phone…
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={cancel}>
                Start over
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}
