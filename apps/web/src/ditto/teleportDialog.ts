/**
 * State for the Teleport progress dialog. A module store (not React state)
 * because the teleport runs from three entry points — the sidebar row menu,
 * the chat header menu, and the `thread.teleport` keybinding — and the dialog
 * is mounted once at the root, the same way the relay client install dialog
 * works.
 *
 * @module ditto/teleportDialog
 */
import type {
  EnvironmentId,
  TeleportCapsuleSummary,
  TeleportProgressEvent,
  TeleportProgressStage,
} from "@t3tools/contracts";

export interface TeleportDialogTarget {
  readonly environmentId: EnvironmentId;
  readonly threadTitle: string;
}

export type TeleportDialogView =
  | {
      readonly status: "running";
      readonly target: TeleportDialogTarget;
      readonly stage: TeleportProgressStage;
      readonly detail: string | null;
      readonly bytesUploaded: number | null;
      readonly bytesTotal: number | null;
    }
  | {
      readonly status: "complete";
      readonly target: TeleportDialogTarget;
      readonly capsule: TeleportCapsuleSummary;
    }
  | { readonly status: "failed"; readonly target: TeleportDialogTarget; readonly message: string };

export type TeleportDialogState =
  | { readonly status: "idle" }
  | TeleportDialogView
  | { readonly status: "closing"; readonly view: TeleportDialogView };

export const TELEPORT_STAGES: ReadonlyArray<{
  readonly stage: TeleportProgressStage;
  readonly label: string;
}> = [
  { stage: "preparing", label: "Reading the working directory" },
  { stage: "bundling", label: "Bundling repositories" },
  { stage: "packing", label: "Packing working tree and session" },
  { stage: "negotiating", label: "Checking what Ditto already has" },
  { stage: "uploading", label: "Uploading" },
  { stage: "committing", label: "Committing the capsule" },
];

const idleState: TeleportDialogState = { status: "idle" };
let state: TeleportDialogState = idleState;
const listeners = new Set<() => void>();

function publish(next: TeleportDialogState) {
  state = next;
  for (const listener of listeners) listener();
}

export function readTeleportDialogState(): TeleportDialogState {
  return state;
}

export function subscribeTeleportDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Pure transition so the dialog's behaviour is testable without React. */
export function reduceTeleportDialog(
  current: TeleportDialogState,
  event:
    | { readonly type: "begin"; readonly target: TeleportDialogTarget }
    | { readonly type: "event"; readonly event: TeleportProgressEvent }
    | { readonly type: "fail"; readonly message: string }
    | { readonly type: "close" }
    | { readonly type: "closed" },
): TeleportDialogState {
  switch (event.type) {
    case "begin":
      // A second teleport while one is on screen is refused by the caller
      // (isTeleportDialogBusy); replacing a closing dialog is fine.
      return {
        status: "running",
        target: event.target,
        stage: "preparing",
        detail: null,
        bytesUploaded: null,
        bytesTotal: null,
      };
    case "event": {
      if (current.status !== "running") return current;
      if (event.event.type === "complete") {
        return { status: "complete", target: current.target, capsule: event.event.capsule };
      }
      return {
        ...current,
        stage: event.event.stage,
        detail: event.event.detail ?? current.detail,
        bytesUploaded: event.event.bytesUploaded ?? null,
        bytesTotal: event.event.bytesTotal ?? current.bytesTotal,
      };
    }
    case "fail":
      if (current.status !== "running") return current;
      return { status: "failed", target: current.target, message: event.message };
    case "close":
      if (current.status === "idle" || current.status === "closing") return current;
      return { status: "closing", view: current };
    case "closed":
      return current.status === "closing" ? idleState : current;
  }
}

export function isTeleportDialogBusy(): boolean {
  return state.status === "running";
}

export function beginTeleportDialog(target: TeleportDialogTarget): void {
  publish(reduceTeleportDialog(state, { type: "begin", target }));
}

export function reportTeleportEvent(event: TeleportProgressEvent): void {
  publish(reduceTeleportDialog(state, { type: "event", event }));
}

export function failTeleportDialog(message: string): void {
  publish(reduceTeleportDialog(state, { type: "fail", message }));
}

export function closeTeleportDialog(): void {
  publish(reduceTeleportDialog(state, { type: "close" }));
}

export function completeTeleportDialogClose(): void {
  publish(reduceTeleportDialog(state, { type: "closed" }));
}

export function resetTeleportDialogForTests(): void {
  publish(idleState);
  listeners.clear();
}

export function formatTeleportBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
