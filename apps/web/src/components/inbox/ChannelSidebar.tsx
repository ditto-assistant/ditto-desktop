import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  ChannelConversation,
  ConnectedChannelAccount,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  HashIcon,
  MessageCircleIcon,
  PlusIcon,
  SmartphoneIcon,
} from "lucide-react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
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

export function ChannelSidebar({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const accountsAtom = serverEnvironment.channelAccounts({ environmentId, input: {} });
  const accountsResult = useAtomValue(accountsAtom);
  const refreshAccounts = useAtomRefresh(accountsAtom);
  const accounts = Option.getOrNull(AsyncResult.value(accountsResult))?.accounts ?? [];

  if (accounts.length === 0) return null;

  return (
    <div className="border-b border-sidebar-border/60 px-[var(--sidebar-content-inset)] pb-2">
      <div className="flex h-7 items-center px-2 text-[10px] font-semibold tracking-[0.08em] text-sidebar-muted-foreground/60 uppercase">
        Chats
      </div>
      <ul className="flex flex-col gap-px" aria-label="Chat sources">
        {accounts.map((account) => (
          <ChannelAccountGroup
            key={account.accountId}
            account={account}
            environmentId={environmentId}
            onConfigured={refreshAccounts}
          />
        ))}
      </ul>
    </div>
  );
}

function ChannelAccountGroup({
  account,
  environmentId,
  onConfigured,
}: {
  readonly account: ConnectedChannelAccount;
  readonly environmentId: EnvironmentId;
  readonly onConfigured: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [configuring, setConfiguring] = useState(false);
  const configure = useAtomCommand(serverEnvironment.configureChannel, { reportFailure: false });
  const conversationsAtom = serverEnvironment.channelConversations({
    environmentId,
    input: { accountId: account.accountId },
  });
  const conversationsResult = useAtomValue(conversationsAtom);
  const conversations = useMemo(
    () =>
      [...(Option.getOrNull(AsyncResult.value(conversationsResult))?.conversations ?? [])].sort(
        (left, right) => (right.latestMessageAt ?? "").localeCompare(left.latestMessageAt ?? ""),
      ),
    [conversationsResult],
  );
  const route = useRouterState({
    select: (state) => ({ pathname: state.location.pathname, search: state.location.search }),
  });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const ServiceIcon = accountIcon(account);
  const selectedAccount = route.pathname === "/inbox" && route.search.account === account.accountId;
  const selectedConversation =
    route.pathname === "/inbox" && typeof route.search.conversation === "string"
      ? route.search.conversation
      : null;

  const enable = async () => {
    setConfiguring(true);
    const result = await configure({
      environmentId,
      input: { accountId: account.accountId, enabled: true },
    });
    setConfiguring(false);
    if (result._tag === "Success") onConfigured();
  };

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
            account.service === "discord"
              ? "bg-[#5865f2]/15 text-[#7c87ff]"
              : "bg-emerald-500/15 text-emerald-500",
          )}
        >
          <ServiceIcon className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{accountLabel(account)}</span>
        <span
          className={cn(
            "size-1.5 rounded-full",
            account.state === "ready"
              ? "bg-emerald-500"
              : account.state === "error" || account.state === "unavailable"
                ? "bg-destructive"
                : "bg-amber-500",
          )}
        />
      </button>

      {expanded ? (
        <ul className="ml-5.5 flex flex-col gap-px border-l border-sidebar-border/60 pl-1.5">
          {!account.enabled && account.service === "discord" ? (
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
                {configuring ? "Installing Discrawl…" : "Turn on Discord sync"}
              </Button>
            </li>
          ) : account.state !== "ready" ? (
            <li className="list-none px-2 py-1.5 text-[11px] leading-4 text-sidebar-muted-foreground/70">
              {account.statusDetail ?? "Setup required"}
            </li>
          ) : conversations.length === 0 ? (
            <li className="list-none px-2 py-1.5 text-[11px] text-sidebar-muted-foreground/60">
              {conversationsResult._tag === "Failure"
                ? String(Cause.squash(conversationsResult.cause))
                : "No conversations yet"}
            </li>
          ) : (
            conversations
              .slice(0, 30)
              .map((conversation) => (
                <ChannelConversationRow
                  key={conversation.conversationId}
                  account={account}
                  conversation={conversation}
                  selected={selectedConversation === conversation.conversationId}
                />
              ))
          )}
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
        <ConversationIcon className="size-3 shrink-0 opacity-65" />
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
