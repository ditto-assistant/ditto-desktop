import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  ChannelConversation,
  ConnectedChannelAccount,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  HashIcon,
  MessageCircleIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SmartphoneIcon,
} from "lucide-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useVisiblePolling } from "../../hooks/useVisiblePolling";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { useSidebar } from "../ui/sidebar";

function compactTime(value?: string): string {
  if (!value) return "";
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

function accountIcon(account: ConnectedChannelAccount) {
  return account.service === "discord" ? MessageCircleIcon : SmartphoneIcon;
}

function accountLabel(account: ConnectedChannelAccount): string {
  if (account.service === "discord") return "Discord";
  if (account.service === "imessage") return "iMessage";
  return account.label;
}

function accountStatus(account: ConnectedChannelAccount): string {
  if (account.state === "ready") return "Synced locally";
  if (account.service === "discord") {
    if (account.state === "syncing") return "Connecting…";
    if (account.state === "error") return "Couldn’t connect. Try again.";
    if (account.state === "unavailable") return "Install and sign in to Discord first.";
    return "Connect Discord";
  }
  if (account.service === "imessage" && account.state === "permission_required") {
    return "Allow Full Disk Access to Ditto in System Settings.";
  }
  if (account.state === "error") return "Couldn’t load chats. Try again.";
  return account.statusDetail ?? "Setup required";
}

export function ChannelSidebar({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const accountsAtom = serverEnvironment.channelAccounts({
    environmentId,
    input: {},
  });
  const accountsResult = useAtomValue(accountsAtom);
  const refreshAccounts = useAtomRefresh(accountsAtom);
  const loadedAccounts = Option.getOrNull(AsyncResult.value(accountsResult))?.accounts;
  const [stableAccounts, setStableAccounts] = useState<ReadonlyArray<ConnectedChannelAccount>>([]);

  // Connection state can change outside the renderer (QR approval, Gateway
  // reconnect, credential restore), so keep the sidebar converged even when a
  // one-shot setup event is missed.
  useVisiblePolling(refreshAccounts, { enabled: true, intervalMs: 10_000 });

  useEffect(() => {
    if (loadedAccounts !== undefined && loadedAccounts.length > 0) {
      setStableAccounts(loadedAccounts);
    }
  }, [loadedAccounts]);

  const accounts = loadedAccounts?.length ? loadedAccounts : stableAccounts;
  const [query, setQuery] = useState("");

  return (
    <div className="border-b border-sidebar-border/60 px-[var(--sidebar-content-inset)] pb-2">
      <div className="flex h-7 items-center px-2 text-[10px] font-semibold tracking-[0.08em] text-sidebar-muted-foreground/60 uppercase">
        Chats
      </div>
      <div className="relative mb-1 px-1">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3 -translate-y-1/2 text-sidebar-muted-foreground/60" />
        <Input
          aria-label="Search chats"
          className="h-7 border-sidebar-border/70 bg-sidebar-accent/30 pr-2 pl-7 text-xs shadow-none"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search Discord and Messages"
          value={query}
        />
      </div>
      <ul className="flex flex-col gap-px" aria-label="Chat sources">
        {accounts.length === 0 ? (
          <li className="list-none px-2 py-1.5 text-[11px] text-sidebar-muted-foreground/60">
            {accountsResult._tag === "Failure"
              ? "Couldn’t load chats. Try again."
              : "Loading chats…"}
          </li>
        ) : (
          accounts.map((account) => (
            <ChannelAccountGroup
              key={account.accountId}
              account={account}
              environmentId={environmentId}
              onConfigured={refreshAccounts}
              query={query}
            />
          ))
        )}
      </ul>
    </div>
  );
}

function ChannelAccountGroup({
  account,
  environmentId,
  onConfigured,
  query,
}: {
  readonly account: ConnectedChannelAccount;
  readonly environmentId: EnvironmentId;
  readonly onConfigured: () => void;
  readonly query: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const [configuring, setConfiguring] = useState(false);
  const [configuredAccount, setConfiguredAccount] = useState<ConnectedChannelAccount | null>(null);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const configure = useAtomCommand(serverEnvironment.configureChannel, {
    reportFailure: false,
  });
  const route = useRouterState({
    select: (state) => ({
      pathname: state.location.pathname,
      search: state.location.search,
    }),
  });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const displayedAccount = configuredAccount ?? account;
  const ServiceIcon = accountIcon(displayedAccount);
  const selectedAccount = route.pathname === "/inbox" && route.search.account === account.accountId;
  const selectedConversation =
    route.pathname === "/inbox" && typeof route.search.conversation === "string"
      ? route.search.conversation
      : null;

  useVisiblePolling(onConfigured, {
    enabled: displayedAccount.state === "syncing" || setupUrl !== null,
    intervalMs: 1_500,
  });

  useEffect(() => {
    if (account.state === "ready" && account.transport === "discord-local-user") {
      setConfiguredAccount(null);
      setSetupUrl(null);
    }
  }, [account.state, account.transport]);

  const enable = async () => {
    setConfiguring(true);
    const result = await configure({
      environmentId,
      input: { accountId: account.accountId, enabled: true },
    });
    setConfiguring(false);
    if (result._tag === "Success") {
      setConfiguredAccount(result.value.account);
      setSetupUrl(result.value.account.setupUrl ?? null);
      onConfigured();
    }
  };

  const liveSendAvailable = displayedAccount.capabilities.some(
    (capability) =>
      capability.operation === "message.send" && capability.availability === "available",
  );
  const canConnectDiscord = displayedAccount.service === "discord" && !liveSendAvailable;

  const openAccount = () => {
    setExpanded((value) => !value);
    void navigate({
      to: "/inbox",
      search: { account: account.accountId },
    });
    if (isMobile) setOpenMobile(false);
  };

  return (
    <li className="list-none">
      <button
        type="button"
        aria-expanded={expanded}
        aria-current={selectedAccount && selectedConversation === null ? "page" : undefined}
        onClick={openAccount}
        className={cn(
          "group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none",
          selectedAccount && selectedConversation === null
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        {expanded ? (
          <ChevronDownIcon className="size-3 shrink-0 opacity-55" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0 opacity-55" />
        )}
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-[4px]",
            displayedAccount.service === "discord"
              ? "bg-[#5865f2]/15 text-[#7c87ff]"
              : "bg-emerald-500/15 text-emerald-500",
          )}
        >
          <ServiceIcon className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {accountLabel(displayedAccount)}
        </span>
        <span
          className={cn(
            "size-1.5 rounded-full",
            displayedAccount.state === "ready"
              ? "bg-emerald-500"
              : displayedAccount.state === "error" || displayedAccount.state === "unavailable"
                ? "bg-destructive"
                : "bg-amber-500",
          )}
        />
      </button>

      {expanded ? (
        <ul className="ml-5.5 flex flex-col gap-px border-l border-sidebar-border/60 pl-1.5">
          {canConnectDiscord ? (
            <li className="list-none py-1 pr-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={configuring}
                onClick={() => void enable()}
                className="h-7 w-full justify-start gap-1.5 px-2 text-xs text-sidebar-muted-foreground"
              >
                <PlusIcon className="size-3" />
                {configuring ? "Connecting…" : "Connect live Discord"}
              </Button>
            </li>
          ) : null}
          {displayedAccount.state !== "ready" ? (
            <li className="list-none px-2 py-1.5 text-[11px] leading-4 text-sidebar-muted-foreground/70">
              {accountStatus(displayedAccount)}
            </li>
          ) : null}
          {displayedAccount.state === "ready" ? (
            <ReadyChannelConversations
              account={displayedAccount}
              environmentId={environmentId}
              query={query}
              selectedConversation={selectedConversation}
            />
          ) : null}
        </ul>
      ) : null}
      <Dialog
        open={setupUrl !== null}
        onOpenChange={(open) => {
          if (!open) setSetupUrl(null);
        }}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Connect Discord</DialogTitle>
            <DialogDescription>
              Scan this code in Discord on a device where you’re signed in, then approve the
              connection.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {setupUrl ? (
              <div className="flex justify-center rounded-xl border border-border/60 bg-white p-4">
                <QRCodeSvg
                  level="M"
                  marginSize={2}
                  size={196}
                  title="Discord connection code"
                  value={setupUrl}
                />
              </div>
            ) : null}
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Your Discord credential stays in this Mac’s credential store.
            </p>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </li>
  );
}

function ReadyChannelConversations({
  account,
  environmentId,
  query,
  selectedConversation,
}: {
  readonly account: ConnectedChannelAccount;
  readonly environmentId: EnvironmentId;
  readonly query: string;
  readonly selectedConversation: string | null;
}) {
  const conversationsAtom = serverEnvironment.channelConversations({
    environmentId,
    input: { accountId: account.accountId },
  });
  const conversationsResult = useAtomValue(conversationsAtom);
  const refreshConversations = useAtomRefresh(conversationsAtom);
  useVisiblePolling(refreshConversations, {
    enabled: account.service === "discord",
    intervalMs: 10_000,
  });
  const loadedConversations = Option.getOrNull(
    AsyncResult.value(conversationsResult),
  )?.conversations;
  const sortedLoadedConversations = useMemo(
    () =>
      [...(loadedConversations ?? [])].sort((left, right) =>
        (right.latestMessageAt ?? "").localeCompare(left.latestMessageAt ?? ""),
      ),
    [loadedConversations],
  );
  const [stableConversations, setStableConversations] = useState(sortedLoadedConversations);
  useEffect(() => {
    if (loadedConversations !== undefined) setStableConversations(sortedLoadedConversations);
  }, [loadedConversations, sortedLoadedConversations]);
  const conversations =
    loadedConversations === undefined ? stableConversations : sortedLoadedConversations;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredConversations = useMemo(
    () =>
      normalizedQuery.length === 0
        ? conversations
        : conversations.filter((conversation) =>
            `${conversation.title} ${conversation.containerTitle ?? ""}`
              .toLocaleLowerCase()
              .includes(normalizedQuery),
          ),
    [conversations, normalizedQuery],
  );

  if (filteredConversations.length === 0) {
    return (
      <li className="list-none px-2 py-1.5 text-[11px] text-sidebar-muted-foreground/60">
        {conversationsResult._tag === "Failure"
          ? "Couldn’t load conversations."
          : normalizedQuery
            ? "No matching chats"
            : "No conversations yet"}
      </li>
    );
  }

  if (account.service !== "discord") {
    return filteredConversations
      .slice(0, 40)
      .map((conversation) => (
        <ChannelConversationRow
          key={conversation.conversationId}
          account={account}
          conversation={conversation}
          selected={selectedConversation === conversation.conversationId}
        />
      ));
  }

  const directMessages = filteredConversations.filter(
    (conversation) => conversation.containerId === undefined,
  );
  const guilds = new Map<
    string,
    {
      title: string;
      avatarUrl?: string;
      conversations: Array<ChannelConversation>;
    }
  >();
  for (const conversation of filteredConversations) {
    if (conversation.containerId === undefined) continue;
    const existing = guilds.get(conversation.containerId);
    if (existing) {
      existing.conversations.push(conversation);
    } else {
      guilds.set(conversation.containerId, {
        title: conversation.containerTitle ?? "Discord server",
        ...(conversation.containerAvatarUrl ? { avatarUrl: conversation.containerAvatarUrl } : {}),
        conversations: [conversation],
      });
    }
  }
  const guildGroups = [...guilds.entries()].sort(([, left], [, right]) => {
    const leftLatest = left.conversations[0]?.latestMessageAt ?? "";
    const rightLatest = right.conversations[0]?.latestMessageAt ?? "";
    return rightLatest.localeCompare(leftLatest);
  });

  return (
    <>
      {directMessages.length > 0 ? (
        <ConversationGroup
          account={account}
          conversations={directMessages}
          defaultExpanded
          forceExpanded={normalizedQuery.length > 0}
          icon={<MessageCircleIcon className="size-3" />}
          label="Direct messages"
          selectedConversation={selectedConversation}
        />
      ) : null}
      {guildGroups.map(([guildId, guild]) => (
        <ConversationGroup
          account={account}
          {...(guild.avatarUrl ? { avatarUrl: guild.avatarUrl } : {})}
          conversations={guild.conversations}
          forceExpanded={normalizedQuery.length > 0}
          icon={<ServerIcon className="size-3" />}
          key={guildId}
          label={guild.title}
          selectedConversation={selectedConversation}
        />
      ))}
    </>
  );
}

function ConversationGroup({
  account,
  avatarUrl,
  conversations,
  defaultExpanded = false,
  forceExpanded,
  icon,
  label,
  selectedConversation,
}: {
  readonly account: ConnectedChannelAccount;
  readonly avatarUrl?: string;
  readonly conversations: ReadonlyArray<ChannelConversation>;
  readonly defaultExpanded?: boolean;
  readonly forceExpanded: boolean;
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly selectedConversation: string | null;
}) {
  const containsSelection = conversations.some(
    (conversation) => conversation.conversationId === selectedConversation,
  );
  const [expanded, setExpanded] = useState(defaultExpanded || containsSelection);
  const visible = forceExpanded || expanded || containsSelection;
  const orderedConversations = [...conversations].sort(
    (left, right) =>
      (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
      (right.latestMessageAt ?? "").localeCompare(left.latestMessageAt ?? ""),
  );

  return (
    <li className="list-none">
      <button
        aria-expanded={visible}
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11px] font-medium text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        {visible ? (
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0 opacity-60" />
        )}
        {avatarUrl ? (
          <img alt="" className="size-4 rounded object-cover" loading="lazy" src={avatarUrl} />
        ) : (
          <span className="flex size-4 items-center justify-center">{icon}</span>
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="text-[9px] tabular-nums opacity-50">{conversations.length}</span>
      </button>
      {visible ? (
        <ul className="ml-3.5 flex flex-col gap-px border-l border-sidebar-border/50 pl-1">
          {orderedConversations.map((conversation) => (
            <ChannelConversationRow
              account={account}
              conversation={conversation}
              key={conversation.conversationId}
              selected={selectedConversation === conversation.conversationId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ChannelConversationRow({
  account,
  conversation,
  selected,
}: {
  readonly account: ConnectedChannelAccount;
  readonly conversation: ChannelConversation;
  readonly selected: boolean;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const ConversationIcon = conversation.kind === "direct" ? MessageCircleIcon : HashIcon;
  const avatarUrl =
    conversation.kind === "direct"
      ? conversation.participants.find((participant) => participant.isSelf !== true)?.avatarUrl
      : undefined;

  return (
    <li className="list-none">
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        onClick={() => {
          void navigate({
            to: "/inbox",
            search: {
              account: account.accountId,
              conversation: conversation.conversationId,
            },
          });
          if (isMobile) setOpenMobile(false);
        }}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none",
          selected
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        {avatarUrl ? (
          <img
            alt=""
            className="size-4 shrink-0 rounded-full object-cover"
            loading="lazy"
            src={avatarUrl}
          />
        ) : (
          <ConversationIcon className="size-3 shrink-0 opacity-65" />
        )}
        <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
        {conversation.unreadCount ? (
          <span className="flex min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground tabular-nums">
            {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
          </span>
        ) : (
          <span className="shrink-0 text-[10px] text-sidebar-muted-foreground/50 tabular-nums">
            {compactTime(conversation.latestMessageAt)}
          </span>
        )}
      </button>
    </li>
  );
}
