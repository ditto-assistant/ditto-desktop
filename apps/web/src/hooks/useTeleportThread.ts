/**
 * The Teleport flow behind every entry point (sidebar row menu, chat header
 * menu, `thread.teleport` keybinding): check the environment has a linked
 * Ditto account, open the progress dialog, stream the capture, and surface the
 * result. Failures land in the dialog, not a toast, so the user can read the
 * reason next to the thread they were teleporting.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { dittoAccountCommands } from "../ditto/account";
import { teleportCommands } from "../ditto/teleport";
import {
  beginTeleportDialog,
  failTeleportDialog,
  isTeleportDialogBusy,
} from "../ditto/teleportDialog";
import { useAtomCommand } from "../state/use-atom-command";

/** Teleport needs a coding harness whose session can be resumed elsewhere. */
export function threadSupportsTeleport(thread: Pick<EnvironmentThreadShell, "session">): boolean {
  const provider = thread.session?.providerName ?? null;
  return provider === "claude" || provider === "codex";
}

export function useTeleportThread() {
  const navigate = useNavigate();
  const getAccountStatus = useAtomCommand(dittoAccountCommands.getStatus, {
    reportFailure: false,
  });
  const teleportThread = useAtomCommand(teleportCommands.thread, { reportFailure: false });

  return useCallback(
    async (
      threadRef: ScopedThreadRef,
      thread: EnvironmentThreadShell,
      workspacePath: string | null,
    ) => {
      if (!workspacePath) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Cannot teleport",
            description: "This thread does not have a workspace path to capture.",
          }),
        );
        return;
      }
      if (isTeleportDialogBusy()) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "A teleport is already running",
            description: "Wait for it to finish before starting another.",
          }),
        );
        return;
      }
      const status = await getAccountStatus({ environmentId: threadRef.environmentId, input: {} });
      if (status._tag === "Failure") {
        if (!isAtomCommandInterrupted(status)) {
          const error = squashAtomCommandFailure(status);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check the Ditto account",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      if (!status.value.linked) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Link your Ditto account first",
            description: "Teleport saves the session to Ditto Cloud under your account.",
            timeout: 8_000,
            actionProps: {
              children: "Open settings",
              onClick: () => {
                void navigate({ to: "/settings/ditto-account" });
              },
            },
          }),
        );
        return;
      }

      beginTeleportDialog({ environmentId: threadRef.environmentId, threadTitle: thread.title });
      const result = await teleportThread({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          cwd: workspacePath,
          providerName: thread.session?.providerName ?? null,
        },
      });
      if (result._tag === "Failure") {
        const error = isAtomCommandInterrupted(result)
          ? new Error("The teleport was interrupted.")
          : squashAtomCommandFailure(result);
        failTeleportDialog(error instanceof Error ? error.message : "The teleport failed.");
      }
    },
    [getAccountStatus, navigate, teleportThread],
  );
}
