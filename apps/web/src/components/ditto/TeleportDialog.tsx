/**
 * Progress and result dialog for Teleport. Mounted once at the root; driven by
 * the module store in `ditto/teleportDialog` so any entry point can open it.
 */
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, RocketIcon, TriangleAlertIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { teleportCommands } from "../../ditto/teleport";
import {
  closeTeleportDialog,
  completeTeleportDialogClose,
  formatTeleportBytes,
  readTeleportDialogState,
  subscribeTeleportDialog,
  TELEPORT_STAGES,
} from "../../ditto/teleportDialog";
import { readLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

/** First turn for a cloud session started from the dialog; the transcript carries the rest. */
const TELEPORT_CLOUD_SESSION_PROMPT =
  "Continue this session where it left off. Summarize the current state of the work first.";

export function TeleportDialog() {
  const state = useSyncExternalStore(
    subscribeTeleportDialog,
    readTeleportDialogState,
    readTeleportDialogState,
  );
  const launchCloudSession = useAtomCommand(teleportCommands.launchCloudSession, {
    reportFailure: false,
  });
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  if (state.status === "idle") return null;
  const view = state.status === "closing" ? state.view : state;
  const isRunning = view.status === "running";
  const stepIndex = isRunning ? TELEPORT_STAGES.findIndex(({ stage }) => stage === view.stage) : -1;
  const step = TELEPORT_STAGES[stepIndex];

  const openInDittoCode = async () => {
    if (view.status !== "complete" || view.capsule.harness === null) return;
    setLaunching(true);
    setLaunchError(null);
    const result = await launchCloudSession({
      environmentId: view.target.environmentId,
      input: {
        capsuleId: view.capsule.capsuleId,
        harness: view.capsule.harness,
        prompt: TELEPORT_CLOUD_SESSION_PROMPT,
      },
    });
    setLaunching(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      setLaunchError(error instanceof Error ? error.message : "Could not start the cloud session.");
      return;
    }
    try {
      await readLocalApi()?.shell.openExternal(result.value.url);
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : "Could not open the link.");
    }
  };

  return (
    <Dialog
      open={state.status !== "closing"}
      onOpenChange={(open) => {
        if (!open && !isRunning) closeTeleportDialog();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          setLaunchError(null);
          completeTeleportDialogClose();
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!isRunning}>
        <DialogHeader>
          <div className="flex size-9 items-center justify-center rounded-lg border border-border/70 bg-muted/60">
            {view.status === "failed" ? (
              <TriangleAlertIcon aria-hidden className="size-4.5 text-destructive" />
            ) : view.status === "complete" ? (
              <CheckIcon aria-hidden className="size-4.5 text-muted-foreground" />
            ) : (
              <RocketIcon aria-hidden className="size-4.5 text-muted-foreground" />
            )}
          </div>
          <DialogTitle>
            {view.status === "running"
              ? "Teleporting thread"
              : view.status === "complete"
                ? "Teleported to Ditto Cloud"
                : "Teleport failed"}
          </DialogTitle>
          <DialogDescription>
            {view.status === "running"
              ? `Saving “${view.target.threadTitle}” with its repositories, working tree, and agent session.`
              : view.status === "complete"
                ? `“${view.target.threadTitle}” is saved as generation ${view.capsule.generation} of ${view.capsule.capsuleName}. Resume it in Ditto Code or on another machine with the Ditto CLI.`
                : view.message}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          {view.status === "running" ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <p aria-live="polite" className="font-medium text-foreground">
                  {step?.label ?? "Working"}
                </p>
                <p className="shrink-0 tabular-nums text-muted-foreground">
                  {view.stage === "uploading" && view.bytesTotal !== null && view.bytesUploaded !== null
                    ? `${formatTeleportBytes(view.bytesUploaded)} of ${formatTeleportBytes(view.bytesTotal)}`
                    : `${stepIndex + 1} of ${TELEPORT_STAGES.length}`}
                </p>
              </div>
              <progress
                aria-label="Teleport progress"
                className="h-2 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
                max={
                  view.stage === "uploading" && view.bytesTotal
                    ? view.bytesTotal
                    : TELEPORT_STAGES.length
                }
                value={
                  view.stage === "uploading" && view.bytesTotal
                    ? (view.bytesUploaded ?? 0)
                    : stepIndex + 1
                }
              />
              {view.detail ? (
                <p className="truncate text-xs leading-relaxed text-muted-foreground">{view.detail}</p>
              ) : null}
            </div>
          ) : view.status === "complete" ? (
            <div className="rounded-xl border border-border/70 bg-muted/35 p-3 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
                <dt>Capsule</dt>
                <dd className="truncate font-medium text-foreground">{view.capsule.capsuleName}</dd>
                <dt>Size</dt>
                <dd className="tabular-nums text-foreground">
                  {formatTeleportBytes(view.capsule.bytes)}
                  {view.capsule.dedupedChunks > 0
                    ? ` · ${view.capsule.dedupedChunks} of ${view.capsule.chunks} chunks already in Ditto`
                    : ""}
                </dd>
                <dt>Session</dt>
                <dd className="truncate text-foreground">
                  {view.capsule.harness === null
                    ? "No resumable agent session"
                    : `${view.capsule.harness === "claude-code" ? "Claude Code" : "Codex"}${view.capsule.harnessSessionId ? ` · ${view.capsule.harnessSessionId.slice(0, 8)}` : ""}`}
                </dd>
              </dl>
              {launchError ? (
                <p className="mt-2 text-xs text-destructive" role="alert">
                  {launchError}
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>
        {isRunning ? null : (
          <DialogFooter>
            <Button variant="outline" onClick={closeTeleportDialog}>
              {view.status === "complete" ? "Done" : "Close"}
            </Button>
            {view.status === "complete" && view.capsule.harness !== null ? (
              <Button disabled={launching} onClick={() => void openInDittoCode()}>
                {launching ? <Spinner /> : null}
                Open in Ditto Code
              </Button>
            ) : null}
          </DialogFooter>
        )}
      </DialogPopup>
    </Dialog>
  );
}
