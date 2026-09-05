/**
 * "Link this computer" row for Ditto Account settings: runs the device-code
 * flow in the renderer, hands the resulting key to the environment (T3
 * server), and shows the linked state with a disconnect action. The key never
 * touches renderer storage.
 */
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DittoAccountStatus } from "@t3tools/contracts";
import { Link2Icon, Link2OffIcon } from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { getDittoApiBaseUrl } from "~/ditto/apiBase";
import { dittoAccountCommands } from "~/ditto/account";
import {
  devicePollIntervalMs,
  INITIAL_DEVICE_LINK_STATE,
  pollDeviceToken,
  reduceDeviceLink,
  requestDeviceCode,
  verificationUrlWithCode,
} from "~/ditto/deviceCode";
import { readPrimaryEnvironmentDescriptor } from "~/environments/primary";

import { readLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

export function DeviceLinkRow() {
  const environmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
  const getStatus = useAtomCommand(dittoAccountCommands.getStatus, { reportFailure: false });
  const link = useAtomCommand(dittoAccountCommands.link, { reportFailure: false });
  const unlink = useAtomCommand(dittoAccountCommands.unlink, { reportFailure: false });
  const [status, setStatus] = useState<DittoAccountStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [flow, dispatch] = useReducer(reduceDeviceLink, INITIAL_DEVICE_LINK_STATE);
  const [disconnecting, setDisconnecting] = useState(false);
  // The poll loop checks this so a cancelled or unmounted flow stops asking Ditto.
  const activeFlowRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    if (environmentId === null) return;
    const result = await getStatus({ environmentId, input: {} });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setStatusError(
          describeError(squashAtomCommandFailure(result), "Could not read the account status."),
        );
      }
      return;
    }
    setStatusError(null);
    setStatus(result.value);
  }, [environmentId, getStatus]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(
    () => () => {
      activeFlowRef.current += 1;
    },
    [],
  );

  const startLinking = useCallback(async () => {
    if (environmentId === null) return;
    const flowId = ++activeFlowRef.current;
    const stillActive = () => activeFlowRef.current === flowId;
    dispatch({ type: "start" });
    let challenge;
    try {
      challenge = await requestDeviceCode();
    } catch (error) {
      if (stillActive()) {
        dispatch({
          type: "error",
          message: describeError(error, "Could not start linking with Ditto."),
        });
      }
      return;
    }
    if (!stillActive()) return;
    dispatch({ type: "challenge", challenge });
    void readLocalApi()
      ?.shell.openExternal(verificationUrlWithCode(challenge))
      .catch(() => {
        // The code stays visible in the row; the user can open the page by hand.
      });

    const deadline = Date.now() + challenge.expiresInSeconds * 1000;
    let slowDowns = 0;
    while (stillActive()) {
      await new Promise((resolve) => setTimeout(resolve, devicePollIntervalMs(challenge, slowDowns)));
      if (!stillActive()) return;
      if (Date.now() > deadline) {
        dispatch({ type: "expired" });
        return;
      }
      let poll;
      try {
        poll = await pollDeviceToken(challenge);
      } catch (error) {
        if (stillActive()) {
          dispatch({ type: "error", message: describeError(error, "Lost contact with Ditto.") });
        }
        return;
      }
      if (!stillActive()) return;
      switch (poll.kind) {
        case "pending":
          dispatch({ type: "pending" });
          continue;
        case "slow-down":
          slowDowns += 1;
          dispatch({ type: "slow-down" });
          continue;
        case "expired":
          dispatch({ type: "expired" });
          return;
        case "denied":
          dispatch({ type: "denied" });
          return;
        case "error":
          dispatch({ type: "error", message: poll.message });
          return;
        case "approved": {
          dispatch({ type: "approved" });
          const linked = await link({
            environmentId,
            input: { apiKey: poll.accessToken, apiBaseUrl: getDittoApiBaseUrl() },
          });
          if (!stillActive()) return;
          if (linked._tag === "Failure") {
            dispatch({
              type: "error",
              message: isAtomCommandInterrupted(linked)
                ? "Linking was interrupted."
                : describeError(
                    squashAtomCommandFailure(linked),
                    "The desktop server refused the key.",
                  ),
            });
            return;
          }
          dispatch({ type: "linked", keyHint: linked.value.keyHint ?? "" });
          setStatus(linked.value);
          return;
        }
      }
    }
  }, [environmentId, link]);

  const cancelLinking = useCallback(() => {
    activeFlowRef.current += 1;
    dispatch({ type: "reset" });
  }, []);

  const disconnect = useCallback(async () => {
    if (environmentId === null) return;
    setDisconnecting(true);
    try {
      const result = await unlink({ environmentId, input: {} });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          setStatusError(
            describeError(squashAtomCommandFailure(result), "Could not disconnect this computer."),
          );
        }
        return;
      }
      setStatus(result.value);
      dispatch({ type: "reset" });
    } finally {
      setDisconnecting(false);
    }
  }, [environmentId, unlink]);

  if (environmentId === null) {
    return (
      <SettingsRow
        {...searchableSetting("ditto-device-link")}
        description="Connect to a desktop server to link it with your Ditto account."
      />
    );
  }

  if (status === null && statusError === null) {
    return (
      <SettingsRow
        {...searchableSetting("ditto-device-link")}
        description="Checking whether this computer is linked…"
        control={<Spinner />}
      />
    );
  }

  if (status?.linked) {
    return (
      <SettingsRow
        {...searchableSetting("ditto-device-link")}
        description={
          <>
            This computer is linked to your Ditto account
            {status.keyHint ? (
              <>
                {" "}
                with key <span className="font-mono text-foreground">…{status.keyHint}</span>
              </>
            ) : null}
            . Teleport and Ditto Code use this link.
          </>
        }
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disconnecting}
            onClick={() => void disconnect()}
          >
            {disconnecting ? <Spinner /> : <Link2OffIcon className="size-3.5" />}
            Disconnect
          </Button>
        }
      />
    );
  }

  const busy = flow.phase === "requesting" || flow.phase === "waiting" || flow.phase === "linking";
  return (
    <SettingsRow
      {...searchableSetting("ditto-device-link")}
      description={
        flow.phase === "waiting" || flow.phase === "linking" ? (
          <>
            Approve this computer in the Ditto app. Your code is{" "}
            <span className="font-mono text-base font-semibold tracking-wide text-foreground">
              {flow.challenge.userCode}
            </span>
            {flow.phase === "linking" ? " — approved, finishing up…" : "."}
          </>
        ) : (
          "Link this computer to your Ditto account so threads can teleport to Ditto Cloud and open in Ditto Code. Ditto issues the desktop its own key; you can revoke it any time from the Ditto app."
        )
      }
      control={
        busy ? (
          <div className="flex items-center gap-2">
            <Spinner />
            <Button type="button" size="sm" variant="outline" onClick={cancelLinking}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" size="sm" onClick={() => void startLinking()}>
            <Link2Icon className="size-3.5" />
            Link this computer
          </Button>
        )
      }
    >
      {flow.phase === "failed" || statusError ? (
        <p className="text-xs text-destructive" role="alert">
          {flow.phase === "failed" ? flow.message : statusError}
        </p>
      ) : null}
    </SettingsRow>
  );
}
