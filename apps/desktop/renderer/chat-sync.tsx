import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { z } from "zod";
import type { User } from "firebase/auth";
import { useAuth } from "@/hooks/useAuth";
import { fetchDittoAPIOrThrow } from "@/lib/fetchDittoAPI";
import { localError, type LocalSelection } from "./local-chat-model";

interface SyncStatus {
  key: string;
  provider: string;
  accountId: string;
  chats: { id: string; enabled: boolean; complete: boolean }[];
  error: string;
  lastSynced: string;
  queued: boolean;
}
const Receipt = z.object({
  sourceId: z.string().uuid(),
  cursor: z.string(),
  windowsWritten: z.number().optional(),
});
type ReceiptValue = z.infer<typeof Receipt>;
interface Work {
  kind: "register" | "ingest" | "pause";
  key: string;
  provider: string;
  sourceId?: string;
  registration?: {
    accountId: string;
    deviceId: string;
    displayName: string;
    consentVersion: string;
  };
  batch?: { previousCursor: string; cursor: string; messages: unknown[] };
}
interface SyncBridge {
  chatSyncStatus(uid: string): Promise<SyncStatus[]>;
  chatSyncSelect(
    uid: string,
    provider: string,
    id: string,
    enabled: boolean,
  ): Promise<SyncStatus[]>;
  chatSyncPrepare(uid: string): Promise<Work | null>;
  chatSyncRegistered(uid: string, key: string, receipt: ReceiptValue): Promise<void>;
  chatSyncAck(uid: string, key: string, receipt: ReceiptValue): Promise<void>;
  chatSyncPaused(uid: string, key: string): Promise<void>;
  chatSyncFailed(uid: string, key: string): Promise<void>;
}
const bridge = () => (window as typeof window & { ditto: SyncBridge }).ditto;
const [statuses, setStatuses] = createSignal<SyncStatus[]>([]);
let kick: (() => void) | undefined;
let cancelCurrent: (() => void) | undefined;

// Mounted by the shared shell, so sync continues when the user moves to Code.
// Tokens remain in Firebase; each request pins the principal captured before await.
export function initializeDesktopChatSync(user: () => User | null | undefined) {
  createEffect(() => {
    const principal = user();
    setStatuses([]);
    if (!principal) return;
    const uid = principal.uid;
    let stopped = false;
    let running = false;
    let consentGeneration = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    const current = () => !stopped && user()?.uid === uid;
    const refresh = async () => {
      const next = await bridge().chatSyncStatus(uid);
      if (current()) setStatuses(next);
    };
    const run = async () => {
      if (!current() || running) return;
      clearTimeout(timer);
      running = true;
      const generation = consentGeneration;
      let work: Work | null = null;
      let failed = false;
      try {
        work = await bridge().chatSyncPrepare(uid);
        if (!current() || generation !== consentGeneration) return;
        if (work) {
          request = new AbortController();
          const path = `/api/v5/users/${encodeURIComponent(uid)}/desktop-chats/${work.provider}/sources`;
          const options = { user: principal, signal: request.signal };
          if (work.kind === "pause") {
            await fetchDittoAPIOrThrow(
              `${path}/${work.sourceId}`,
              z.object({ paused: z.boolean() }),
              { ...options, method: "DELETE" },
            );
            if (current()) await bridge().chatSyncPaused(uid, work.key);
          } else if (work.kind === "register") {
            const receipt = await fetchDittoAPIOrThrow(path, Receipt, {
              ...options,
              method: "POST",
              body: work.registration,
            });
            if (current()) await bridge().chatSyncRegistered(uid, work.key, receipt);
          } else {
            const receipt = await fetchDittoAPIOrThrow(`${path}/${work.sourceId}/ingest`, Receipt, {
              ...options,
              method: "POST",
              body: work.batch,
            });
            if (current()) await bridge().chatSyncAck(uid, work.key, receipt);
          }
        }
      } catch {
        failed = true;
        if (current() && work) await bridge().chatSyncFailed(uid, work.key);
      } finally {
        running = false;
        if (current()) {
          await refresh();
          timer = setTimeout(() => void run(), failed ? 60000 : work ? 2000 : 15000);
        }
      }
    };
    const trigger = () => {
      clearTimeout(timer);
      void run();
    };
    kick = trigger;
    cancelCurrent = () => {
      ++consentGeneration;
      request?.abort();
    };
    void refresh();
    trigger();
    onCleanup(() => {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
      if (kick === trigger) {
        kick = undefined;
        cancelCurrent = undefined;
      }
    });
  });
}

export function LocalChatCloudSync(props: { selection: LocalSelection; accountId?: string }) {
  const { user } = useAuth();
  const [confirm, setConfirm] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  createEffect(() => {
    void props.selection.service;
    void props.selection.conversation?.id;
    void user()?.uid;
    setConfirm(false);
    setError("");
  });
  const source = () =>
    statuses().find(
      (s) => s.provider === props.selection.service && s.accountId === props.accountId,
    );
  const enabled = () =>
    source()?.chats.some((c) => c.id === props.selection.conversation?.id && c.enabled) || false;
  const select = async (value: boolean) => {
    const principal = user();
    const conversation = props.selection.conversation;
    if (!principal || !conversation) return;
    setBusy(true);
    setError("");
    cancelCurrent?.();
    try {
      const next = await bridge().chatSyncSelect(
        principal.uid,
        props.selection.service,
        conversation.id,
        value,
      );
      if (user()?.uid === principal.uid) {
        setStatuses(next);
        setConfirm(false);
        kick?.();
      }
    } catch (failure) {
      setError(localError(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show
      when={
        ["discord", "googlemessages"].includes(props.selection.service) &&
        props.selection.conversation
      }
    >
      <div class="ditto-chat-sync">
        <button
          type="button"
          disabled={busy() || !user()}
          onClick={() => (enabled() ? void select(false) : setConfirm(!confirm()))}
        >
          {enabled() ? "Pause cloud sync" : "Sync this chat to Ditto Cloud"}
        </button>
        <Show when={enabled()}>
          <span role="status">
            {source()?.error ||
              (source()?.queued
                ? "Queued for cloud sync"
                : source()?.lastSynced
                  ? "Synced to Ditto Cloud"
                  : "Waiting for cloud sync")}
          </span>
          <Show when={source()?.error}>
            <button type="button" onClick={() => kick?.()}>
              Retry
            </button>
          </Show>
        </Show>
        <Show when={!user()}>
          <span>Sign in with Ditto to sync.</span>
        </Show>
        <Show when={confirm()}>
          <div class="ditto-chat-sync-consent" role="group" aria-label="Confirm chat cloud sync">
            <p>
              Upload this conversation’s available history and future messages to your signed-in
              Ditto account. Ditto Cloud stores the transcript and searchable memories. Your chat
              sign-in stays on this Mac. Pausing stops future uploads; it does not delete uploaded
              history.
            </p>
            <button type="button" disabled={busy()} onClick={() => void select(true)}>
              Enable cloud sync for this chat
            </button>
            <button type="button" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </Show>
        <Show when={error()}>
          <span role="alert">{error()}</span>
        </Show>
      </div>
    </Show>
  );
}
