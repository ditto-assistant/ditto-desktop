import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { LocalChatCloudSync } from "./chat-sync";
import { toast } from "sonner-solid";
import type { ConnectorMessage, Connection } from "@/api/connectors";
import type { Session } from "@/api/sessions";
import type {
  useConnectorMessages,
  UseConnectorMessagesResult,
} from "@/hooks/useConnectorMessages";
import { useSurfaceCoordinator } from "@/hooks/useSurfaceCoordinator";
import ConnectorLogo from "@/components/connectors/ConnectorLogo";
import V2ConnectorChatSurface from "@/components/v2/V2ConnectorChatSurface";
import {
  canSendLocally,
  isLocalSessionID,
  localConnectorMessage,
  localError,
  localServiceName,
  localServices,
  localSessionID,
  sendLocalMessage,
  type LocalConversation,
  type LocalMessage,
  type LocalSelection,
  type LocalService,
  type LocalStatus,
} from "./local-chat-model";
export { isLocalSessionID, localServices, localServiceName };

interface ChannelEvent {
  service: LocalService;
  event: string;
  data?: { channelId?: string };
}
interface DesktopBridge {
  channelStatus: (service: LocalService) => Promise<LocalStatus>;
  channelConversations: (service: LocalService) => Promise<LocalConversation[]>;
  channelMessages: (service: LocalService, id: string, limit: number) => Promise<LocalMessage[]>;
  channelSend: (
    service: LocalService,
    id: string,
    text: string,
    handle?: string,
  ) => Promise<unknown>;
  channelLogin: (
    service: LocalService,
    method?: string,
  ) => Promise<LocalStatus & { expiresInSeconds?: number }>;
  channelCancelLogin: (service: LocalService) => Promise<unknown>;
  channelLogout: (service: LocalService) => Promise<unknown>;
  messagesSettings: () => Promise<unknown>;
  createPacket: (
    service: LocalService,
    id: string,
  ) => Promise<{ path: string; messageCount: number }>;
  onChannelEvent: (listener: (event: ChannelEvent) => void) => () => void;
}
const bridge = () => (window as typeof window & { ditto: DesktopBridge }).ditto;
interface ChannelState {
  status?: LocalStatus;
  rows: LocalConversation[];
  loading?: boolean;
  error?: string;
}
const [channels, setChannels] = createSignal<Partial<Record<LocalService, ChannelState>>>({});
export const [localSelection, setLocalSelection] = createSignal<LocalSelection | null>(null);
export const clearLocalSelection = () => setLocalSelection(null);
const update = (service: LocalService, value: Partial<ChannelState>) =>
  setChannels((current) => ({
    ...current,
    [service]: { rows: [], ...current[service], ...value },
  }));
const flights = new Map<LocalService, Promise<void>>();
async function refreshChannel(service: LocalService): Promise<void> {
  if (flights.has(service)) return flights.get(service);
  const request = (async () => {
    update(service, { loading: true, error: "" });
    try {
      const status = await bridge().channelStatus(service);
      update(service, { status, rows: status.connected ? (channels()[service]?.rows ?? []) : [] });
      const rows = status.connected ? await bridge().channelConversations(service) : [];
      update(service, { rows });
    } catch (error) {
      update(service, { error: localError(error) });
    } finally {
      update(service, { loading: false });
    }
  })();
  flights.set(service, request);
  try {
    await request;
  } finally {
    flights.delete(service);
  }
}
let initialized = false;
export function initializeLocalChannels() {
  if (initialized || !bridge()) return;
  initialized = true;
  for (const service of localServices) void refreshChannel(service);
  bridge().onChannelEvent((event) => {
    if (
      [
        "connection.ready",
        "login.completed",
        "connection.status",
        "connection.error",
        "login.failed",
      ].includes(event.event)
    )
      void refreshChannel(event.service);
  });
}
export const localSessions = createMemo<Session[]>(() =>
  localServices.flatMap((service) =>
    (channels()[service]?.rows ?? []).map((row) => ({
      id: localSessionID(service, row.id),
      type: "external" as const,
      title: [row.title || "Untitled chat", row.guildName].filter(Boolean).join(" · "),
      status: "active",
      pinned: false,
      createdAt: row.latestMessageAt || "",
      updatedAt: row.latestMessageAt || "",
      metadata: {
        provider: service,
        connector: localServiceName(service),
        source: "desktop-local",
        threadId: row.id,
        threadKind: row.kind,
        chat: row.title,
        contactHandle: row.handle,
      },
    })),
  ),
);
export const localHeaderSession = createMemo(() => {
  const selected = localSelection();
  return selected?.conversation
    ? (localSessions().find(
        (session) => session.id === localSessionID(selected.service, selected.conversation!.id),
      ) ?? null)
    : null;
});

export function localConnection(session: Session): Connection | null {
  const selection = localSelection();
  if (
    !selection?.conversation ||
    session.id !== localSessionID(selection.service, selection.conversation.id)
  )
    return null;
  return {
    id: `desktop-local:${selection.service}`,
    provider: selection.service,
    name: localServiceName(selection.service),
    displayName: channels()[selection.service]?.status?.user?.displayName || "",
    status: channels()[selection.service]?.status?.connected ? "active" : "disconnected",
    graphId: "",
    agentId: "",
    logoKey: selection.service,
    messageCount: 0,
    isCatchingUp: false,
    lastError: "",
    capabilities: {
      canSend: !!channels()[selection.service]?.status?.connected && canSendLocally(selection),
      sendHint: canSendLocally(selection)
        ? "Sends as you from this Mac"
        : "This iMessage group is read-only on this Mac",
      sendMode: "user",
    },
  };
}
export function openLocalSession(id: string): boolean {
  const session = localSessions().find((row) => row.id === id);
  if (!session) return false;
  const service = session.metadata!.provider as LocalService;
  const conversation = channels()[service]?.rows.find(
    (row) => localSessionID(service, row.id) === id,
  );
  if (!conversation) return false;
  setLocalSelection({ service, conversation });
  return true;
}

export function LocalChatRow(props: { session: Session; onNavigate?: () => void }) {
  const surfaces = useSurfaceCoordinator();
  const selected = () => {
    const current = localSelection();
    return (
      !!current?.conversation &&
      localSessionID(current.service, current.conversation.id) === props.session.id
    );
  };
  return (
    <div class="v2-studio-recent-row" classList={{ "is-selected": selected() }}>
      <button
        type="button"
        class="v2-studio-recent"
        aria-label={`${props.session.title}, Local ${props.session.metadata?.connector}`}
        aria-current={selected() ? "page" : undefined}
        onClick={() => {
          surfaces.openChatDirectory();
          openLocalSession(props.session.id);
          props.onNavigate?.();
        }}
      >
        <ConnectorLogo provider={props.session.metadata?.provider} size={17} />
        <span>{props.session.title || "Untitled chat"}</span>
        <span class="ditto-local-badge">Local</span>
      </button>
    </div>
  );
}
export function LocalChatRows(props: {
  provider?: string;
  search?: string;
  onNavigate?: () => void;
  showSetup?: boolean;
  showConversations?: boolean;
}) {
  const surfaces = useSurfaceCoordinator();
  onMount(initializeLocalChannels);
  const service = () => localServices.find((row) => row === props.provider);
  const state = () => (service() ? channels()[service()!] : undefined);
  const [limit, setLimit] = createSignal(100);
  const rows = createMemo(() =>
    (state()?.rows ?? []).filter((row) =>
      `${row.title} ${row.guildName || ""}`
        .toLowerCase()
        .includes((props.search || "").toLowerCase()),
    ),
  );
  const open = (conversation?: LocalConversation) => {
    const provider = service();
    if (!provider) return;
    surfaces.openChatDirectory();
    setLocalSelection({ service: provider, conversation });
    props.onNavigate?.();
  };
  return (
    <Show when={service()}>
      <Show when={props.showSetup !== false}>
        <button
          type="button"
          class="v2-studio-recent ditto-local-connection"
          onClick={() => open()}
          aria-label={`Manage ${localServiceName(service()!)} on this Mac`}
        >
          <span>
            {state()?.status?.connected ? "Connected on this Mac" : "Connect on this Mac"}
          </span>
          <span class="ditto-local-badge">Local</span>
        </button>
      </Show>
      <Show when={state()?.loading && !rows().length}>
        <p class="v2-studio-sidebar-status" role="status">
          Checking local chats…
        </p>
      </Show>
      <Show when={state()?.error}>
        <p class="v2-studio-sidebar-status" role="status">
          {state()?.error}
        </p>
      </Show>
      <Show when={props.showConversations !== false}>
        <For each={rows().slice(0, limit())}>
          {(row) => (
            <LocalChatRow
              session={localSessions().find(
                (session) => session.id === localSessionID(service()!, row.id),
              )!}
              onNavigate={props.onNavigate}
            />
          )}
        </For>
        <Show when={rows().length > limit()}>
          <button
            type="button"
            class="v2-studio-sidebar-retry"
            onClick={() => setLimit((value) => value + 100)}
          >
            Show more chats
          </button>
        </Show>
      </Show>
    </Show>
  );
}

/** The web transcript/composer owns rendering and drafts; this hook replaces only transport. */
export function useLocalConnectorMessages(
  sessionID: () => string | null,
  opts?: Parameters<typeof useConnectorMessages>[1],
): UseConnectorMessagesResult {
  const selection = untrack(localSelection);
  if (!selection?.conversation) throw new Error("No local conversation selected");
  const destination = { ...selection, conversation: { ...selection.conversation } };
  const id = localSessionID(destination.service, destination.conversation.id);
  const [messages, setMessages] = createSignal<ConnectorMessage[]>([]);
  const [pending, setPending] = createSignal(true);
  const [failed, setFailed] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  const refresh = async () => {
    if (inFlight) return inFlight;
    const request = (async () => {
      try {
        const rows = await bridge().channelMessages(
          destination.service,
          destination.conversation.id,
          200,
        );
        if (!disposed) {
          setMessages(
            rows.map((row) =>
              localConnectorMessage(destination.service, destination.conversation.id, row),
            ),
          );
          setFailed(false);
        }
      } catch {
        if (!disposed) setFailed(true);
      } finally {
        if (!disposed) setPending(false);
      }
    })();
    inFlight = request;
    try {
      await request;
    } finally {
      inFlight = null;
    }
  };
  let eventTimer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = bridge().onChannelEvent((event) => {
    if (
      event.service !== destination.service ||
      !event.event.startsWith("message.") ||
      event.data?.channelId !== destination.conversation.id
    )
      return;
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => void refresh(), 300);
  });
  onMount(() => void refresh());
  const recovery = setInterval(() => {
    if (!document.hidden) void refresh();
  }, 15000);
  onCleanup(() => {
    disposed = true;
    unsubscribe();
    clearInterval(recovery);
    clearTimeout(eventTimer);
  });
  return {
    messages,
    refresh,
    hasMore: () => false,
    fetchOlder: refresh,
    isFetchingOlder: () => false,
    isPending: pending,
    isError: failed,
    decision: () => "native",
    isSending: sending,
    isMutating: () => false,
    reactionOptions: () => ({ reactions: [], customAllowed: false }),
    react: () => {},
    edit: () => {},
    remove: () => {},
    send: (text, options) => {
      if (sending() || sessionID() !== id) return;
      setSending(true);
      const sent = {
        text: text.trim(),
        sessionID: id,
        actionId: crypto.randomUUID(),
        key: ["connector-messages", undefined, id] as const,
        files: [...(options?.files ?? [])],
        replyToMessageId: options?.replyToMessageId ?? "",
        mentions: [...(options?.mentions ?? [])],
      };
      void sendLocalMessage(bridge(), destination, text, options)
        .then(
          async () => {
            if (!disposed) opts?.onSendSuccess?.(sent);
            await refresh();
          },
          (error) => {
            if (!disposed) {
              opts?.onSendError?.(sent.text, id, sent.actionId, sent.files, error, options ?? {});
              toast.error(localError(error));
            }
          },
        )
        .finally(() => {
          if (!disposed) setSending(false);
        });
    },
  };
}

export function LocalChatSurface() {
  const selection = () => localSelection()!;
  const service = () => selection().service;
  const state = () => channels()[service()];
  const surfaces = useSurfaceCoordinator();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [packetBusy, setPacketBusy] = createSignal(false);
  const [qr, setQR] = createSignal("");
  let loginTimer: ReturnType<typeof setTimeout> | undefined;
  let loginGeneration = 0;
  const pollLogin = async (provider: LocalService, generation: number, deadline: number) => {
    await refreshChannel(provider);
    if (generation !== loginGeneration) return;
    const status = channels()[provider]?.status;
    setQR(status?.qrDataUrl || "");
    if (status?.connected) {
      setBusy(false);
      setQR("");
      return;
    }
    if (status?.loginPending || status?.restoring) {
      if (Date.now() < deadline)
        loginTimer = setTimeout(() => void pollLogin(provider, generation, deadline), 2500);
      else {
        setBusy(false);
        setQR("");
        setError("Sign-in expired. Connect again to retry.");
      }
    } else {
      setBusy(false);
      setQR("");
    }
  };
  createEffect(() => {
    const provider = service();
    clearTimeout(loginTimer);
    const generation = ++loginGeneration;
    setError("");
    setBusy(false);
    setQR("");
    // Account events and explicit Refresh update the directory. Merely opening
    // another conversation must not refetch every Discord server/channel.
    const knownStatus = untrack(() => channels()[provider]?.status);
    const ready =
      knownStatus && !knownStatus.loginPending && !knownStatus.restoring
        ? Promise.resolve()
        : refreshChannel(provider);
    void ready.then(() => {
      if (generation !== loginGeneration) return;
      const status = channels()[provider]?.status;
      if (status?.loginPending || status?.restoring) {
        setBusy(true);
        void pollLogin(provider, generation, Date.now() + 180000);
      }
    });
  });
  onCleanup(() => {
    ++loginGeneration;
    clearTimeout(loginTimer);
  });
  const connect = async (method?: string) => {
    const provider = service(),
      generation = ++loginGeneration;
    setBusy(true);
    setError("");
    try {
      const result = await bridge().channelLogin(provider, method);
      if (generation !== loginGeneration) return;
      setQR(result.qrDataUrl || "");
      void pollLogin(provider, generation, Date.now() + (result.expiresInSeconds || 180) * 1000);
    } catch (failure) {
      if (generation === loginGeneration) {
        setError(localError(failure));
        setBusy(false);
      }
    }
  };
  const cancelLogin = async () => {
    const provider = service();
    ++loginGeneration;
    clearTimeout(loginTimer);
    setQR("");
    setError("");
    try {
      await bridge().channelCancelLogin(provider);
      await refreshChannel(provider);
    } catch (failure) {
      if (service() === provider) setError(localError(failure));
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    const provider = service();
    setBusy(true);
    setError("");
    try {
      await bridge().channelLogout(provider);
      await refreshChannel(provider);
    } catch (failure) {
      if (service() === provider) setError(localError(failure));
    } finally {
      setBusy(false);
    }
  };
  const packet = async () => {
    const destination = selection();
    if (!destination.conversation) return;
    setPacketBusy(true);
    try {
      const result = await bridge().createPacket(destination.service, destination.conversation.id);
      surfaces.openPrimary("code");
      window.dispatchEvent(new CustomEvent("ditto-desktop-local-packet", { detail: result }));
    } catch (failure) {
      toast.error(localError(failure));
    } finally {
      setPacketBusy(false);
    }
  };
  return (
    <section class="ditto-integrated-chat" aria-label={`${localServiceName(service())} local chat`}>
      <LocalChatCloudSync selection={selection()} accountId={state()?.status?.user?.id} />
      <Show when={!selection().conversation}>
        <header class="ditto-integrated-chat-head">
          <ConnectorLogo provider={service()} size={22} />
          <strong>{selection().conversation?.title || localServiceName(service())}</strong>
          <span class="ditto-local-badge">Local</span>
        </header>
      </Show>
      <Show
        when={selection().conversation && state()?.status?.connected}
        fallback={
          <div class="ditto-local-setup">
            <ConnectorLogo provider={service()} size={42} />
            <h2>{localServiceName(service())} on this Mac</h2>
            <p role="status">
              {error() || state()?.error || state()?.status?.detail || "Checking local connection…"}
            </p>
            <Show
              when={state()?.status?.connected}
              fallback={
                <p>
                  {service() === "imessage"
                    ? "Allow Ditto Desktop in System Settings → Privacy & Security → Full Disk Access to read Messages."
                    : state()?.status?.configured === false
                      ? "This build needs the local chat component configured before sign-in is available."
                      : "Connect your account on this Mac to read chats and send messages as yourself. Your cloud chats stay in the same app group."}
                </p>
              }
            >
              <p>
                Signed in as {state()?.status?.user?.displayName || "you"}. Choose a conversation in
                the sidebar.
              </p>
            </Show>
            <Show when={qr()}>
              <img
                class="ditto-inbox-qr"
                src={qr()}
                alt={`Scan with ${localServiceName(service())} on your phone`}
              />
              <p>
                {service() === "discord"
                  ? "Discord → You → Scan QR Code"
                  : service() === "googlemessages"
                    ? "Google Messages → Device pairing → Scan QR code"
                    : "Telegram → Settings → Devices → Link Desktop Device"}
              </p>
            </Show>
            <div class="ditto-local-setup-actions">
              <Show
                when={
                  service() !== "imessage" &&
                  !state()?.status?.connected &&
                  state()?.status?.configured !== false
                }
              >
                <button
                  type="button"
                  disabled={busy() || state()?.loading}
                  onClick={() => void connect()}
                >
                  {busy() ? "Waiting for sign-in…" : "Connect on this Mac"}
                </button>
              </Show>
              <Show
                when={
                  busy() &&
                  ["discord", "googlemessages"].includes(service()) &&
                  !state()?.status?.connected
                }
              >
                <button type="button" onClick={() => void cancelLogin()}>
                  Cancel sign-in
                </button>
              </Show>
              <Show when={service() === "googlemessages" && !state()?.status?.connected}>
                <button type="button" disabled={busy()} onClick={() => void connect("google")}>
                  Sign in with Google
                </button>
              </Show>
              <Show when={service() === "imessage" && !state()?.status?.connected}>
                <button type="button" onClick={() => void bridge().messagesSettings()}>
                  Open Full Disk Access settings
                </button>
              </Show>
              <button
                type="button"
                disabled={state()?.loading}
                onClick={() => void refreshChannel(service())}
              >
                Refresh
              </button>
              <Show when={service() !== "imessage" && state()?.status?.connected}>
                <button type="button" disabled={busy()} onClick={() => void disconnect()}>
                  Disconnect this Mac
                </button>
              </Show>
            </div>
          </div>
        }
      >
        <Show when={localSessionID(service(), selection().conversation!.id)} keyed>
          {(id) => (
            <V2ConnectorChatSurface
              session={
                localSessions().find((row) => row.id === id) || {
                  id,
                  type: "external",
                  title: selection().conversation!.title,
                  status: "active",
                  pinned: false,
                  createdAt: "",
                  updatedAt: "",
                  metadata: {
                    provider: service(),
                    connector: localServiceName(service()),
                    threadKind: selection().conversation!.kind,
                    chat: selection().conversation!.title,
                  },
                }
              }
            />
          )}
        </Show>
      </Show>
      <Show when={selection().conversation && state()?.status?.connected}>
        <div class="connector-destination-shelf ditto-local-destination-shelf">
          <div class="v2-connector-mode-toggle" role="group" aria-label="Send to">
            <button
              type="button"
              class="v2-connector-mode-option"
              aria-pressed="true"
              disabled={!canSendLocally(selection())}
              aria-label={`Reply in ${localServiceName(service())} as yourself on this Mac`}
              onClick={(event) =>
                event.currentTarget
                  .closest("section")
                  ?.querySelector<HTMLTextAreaElement>("textarea")
                  ?.focus()
              }
            >
              <ConnectorLogo provider={service()} size={18} />
              <span class="v2-connector-mode-label">Reply in {localServiceName(service())}</span>
            </button>
            <button
              type="button"
              class="v2-connector-mode-option"
              disabled={packetBusy()}
              onClick={() => void packet()}
              aria-label="Use this local conversation in Ditto Code"
            >
              <span class="v2-connector-mode-label">Use in Ditto Code →</span>
            </button>
          </div>
        </div>
      </Show>
    </section>
  );
}
