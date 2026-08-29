import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  ChannelConversation,
  ChannelMessage,
  ConnectedChannelAccount,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  ArrowUpIcon,
  HashIcon,
  InboxIcon,
  MessageCircleIcon,
  RefreshCwIcon,
  SmartphoneIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn, randomUUID } from "../../lib/utils";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

function formatTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(Date.now() - date.valueOf() > 86_400_000 ? { month: "short", day: "numeric" } : {}),
  }).format(date);
}

function failureMessage(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  return result._tag === "Failure" ? String(Cause.squash(result.cause)) : null;
}

export function InboxPage() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  return environmentId === null ? (
    <InboxFrame>
      <EmptyPanel title="No local device connected" detail="Connect this desktop to open Inbox." />
    </InboxFrame>
  ) : (
    <ConnectedInbox environmentId={environmentId} />
  );
}

function InboxFrame({ children }: { readonly children: React.ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 items-center gap-2 px-3 text-sm font-medium">
            <InboxIcon className="size-4 text-muted-foreground" />
            <span>Inbox</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              Local
            </span>
          </div>
        </WorkspacePageHeader>
        {children}
      </div>
    </SidebarInset>
  );
}

function ConnectedInbox({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const accountsAtom = serverEnvironment.channelAccounts({ environmentId, input: {} });
  const accountsResult = useAtomValue(accountsAtom);
  const refreshAccounts = useAtomRefresh(accountsAtom);
  const accounts = Option.getOrNull(AsyncResult.value(accountsResult))?.accounts ?? [];
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const selectedAccount =
    accounts.find((account) => account.accountId === selectedAccountId) ?? accounts[0] ?? null;

  useEffect(() => {
    if (selectedAccountId === null && accounts[0] !== undefined) {
      setSelectedAccountId(accounts[0].accountId);
    }
  }, [accounts, selectedAccountId]);

  return (
    <InboxFrame>
      <div className="flex min-h-0 flex-1 flex-col">
        <AccountStrip
          accounts={accounts}
          environmentId={environmentId}
          error={failureMessage(accountsResult)}
          onRefresh={refreshAccounts}
          onSelect={setSelectedAccountId}
          selectedAccountId={selectedAccount?.accountId ?? null}
        />
        {selectedAccount === null ? (
          <EmptyPanel
            title="Looking for local chats"
            detail="Discord and Messages accounts will appear here when this device reports them."
          />
        ) : (
          <ConversationWorkspace account={selectedAccount} environmentId={environmentId} />
        )}
      </div>
    </InboxFrame>
  );
}

function AccountStrip({
  accounts,
  environmentId,
  error,
  onRefresh,
  onSelect,
  selectedAccountId,
}: {
  readonly accounts: ReadonlyArray<ConnectedChannelAccount>;
  readonly environmentId: EnvironmentId;
  readonly error: string | null;
  readonly onRefresh: () => void;
  readonly onSelect: (accountId: string) => void;
  readonly selectedAccountId: string | null;
}) {
  const configure = useAtomCommand(serverEnvironment.configureChannel, { reportFailure: false });
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const toggle = async (account: ConnectedChannelAccount, enabled: boolean) => {
    setBusyAccountId(account.accountId);
    setLocalError(null);
    const result = await configure({
      environmentId,
      input: { accountId: account.accountId, enabled },
    });
    if (result._tag === "Failure") setLocalError(String(Cause.squash(result.cause)));
    setBusyAccountId(null);
    onRefresh();
  };

  return (
    <div className="border-b border-border bg-muted/20 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
        {accounts.map((account) => {
          const active = selectedAccountId === account.accountId;
          const canToggle = account.service === "discord";
          return (
            <button
              key={account.accountId}
              className={cn(
                "flex min-w-64 items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                active
                  ? "border-foreground/20 bg-background shadow-xs"
                  : "border-transparent hover:bg-background/60",
              )}
              onClick={() => onSelect(account.accountId)}
              type="button"
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-md",
                  account.service === "discord"
                    ? "bg-[#5865f2]/15 text-[#7c87ff]"
                    : "bg-emerald-500/15 text-emerald-500",
                )}
              >
                {account.service === "discord" ? (
                  <MessageCircleIcon className="size-4" />
                ) : (
                  <SmartphoneIcon className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{account.label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {account.state === "ready" ? "Synced locally" : account.statusDetail}
                </span>
              </span>
              {canToggle ? (
                <Switch
                  aria-label="Discord sync"
                  checked={account.enabled}
                  disabled={busyAccountId === account.accountId}
                  onCheckedChange={(checked) => void toggle(account, checked)}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <span
                  className={cn(
                    "size-2 rounded-full",
                    account.state === "ready" ? "bg-emerald-500" : "bg-amber-500",
                  )}
                />
              )}
            </button>
          );
        })}
        <Button aria-label="Refresh accounts" onClick={onRefresh} size="icon-sm" variant="ghost">
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      {(localError ?? error) ? (
        <p className="mt-2 text-xs text-destructive">{localError ?? error}</p>
      ) : null}
    </div>
  );
}

function ConversationWorkspace({
  account,
  environmentId,
}: {
  readonly account: ConnectedChannelAccount;
  readonly environmentId: EnvironmentId;
}) {
  const conversationsAtom = serverEnvironment.channelConversations({
    environmentId,
    input: { accountId: account.accountId },
  });
  const result = useAtomValue(conversationsAtom);
  const refresh = useAtomRefresh(conversationsAtom);
  const conversations = useMemo(
    () =>
      [...(Option.getOrNull(AsyncResult.value(result))?.conversations ?? [])].sort((left, right) =>
        (right.latestMessageAt ?? "").localeCompare(left.latestMessageAt ?? ""),
      ),
    [result],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected =
    conversations.find((conversation) => conversation.conversationId === selectedId) ??
    conversations[0] ??
    null;

  useEffect(() => {
    setSelectedId(null);
  }, [account.accountId]);

  if (!account.enabled || account.state !== "ready") {
    return (
      <EmptyPanel title={account.label} detail={account.statusDetail ?? "Setup is required."} />
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-r border-border bg-muted/10">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Conversations
          </span>
          <Button
            aria-label="Refresh conversations"
            onClick={refresh}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {conversations.length === 0 ? (
            <p className="p-4 text-xs leading-relaxed text-muted-foreground">
              {failureMessage(result) ?? "No conversations found in the local archive yet."}
            </p>
          ) : (
            <div className="p-1.5">
              {conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.conversationId}
                  conversation={conversation}
                  onClick={() => setSelectedId(conversation.conversationId)}
                  selected={selected?.conversationId === conversation.conversationId}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </aside>
      {selected === null ? (
        <EmptyPanel
          title="No conversation selected"
          detail="Choose a thread from the local inbox."
        />
      ) : (
        <MessagePanel account={account} conversation={selected} environmentId={environmentId} />
      )}
    </div>
  );
}

function ConversationRow({
  conversation,
  onClick,
  selected,
}: {
  readonly conversation: ChannelConversation;
  readonly onClick: () => void;
  readonly selected: boolean;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      onClick={onClick}
      type="button"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
        {conversation.kind === "direct" ? (
          <MessageCircleIcon className="size-3.5" />
        ) : (
          <HashIcon className="size-3.5" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{conversation.title}</span>
        <span className="block text-[10px] text-muted-foreground">
          {conversation.unreadCount ? `${conversation.unreadCount} unread · ` : ""}
          {formatTime(conversation.latestMessageAt)}
        </span>
      </span>
    </button>
  );
}

function MessagePanel({
  account,
  conversation,
  environmentId,
}: {
  readonly account: ConnectedChannelAccount;
  readonly conversation: ChannelConversation;
  readonly environmentId: EnvironmentId;
}) {
  const messagesAtom = serverEnvironment.channelMessages({
    environmentId,
    input: {
      accountId: account.accountId,
      conversationId: conversation.conversationId,
      limit: 150,
    },
  });
  const result = useAtomValue(messagesAtom);
  const refresh = useAtomRefresh(messagesAtom);
  const messages = useMemo(
    () =>
      [...(Option.getOrNull(AsyncResult.value(result))?.messages ?? [])].sort((left, right) =>
        left.sentAt.localeCompare(right.sentAt),
      ),
    [result],
  );
  const canSend = account.capabilities.some(
    (capability) =>
      capability.operation === "message.send" && capability.availability === "available",
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{conversation.title}</p>
          <p className="text-[10px] text-muted-foreground">
            {account.service === "discord" ? "Device cache · read only" : "Messages on this Mac"}
          </p>
        </div>
        <Button aria-label="Refresh messages" onClick={refresh} size="icon-sm" variant="ghost">
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-5 py-6">
          {messages.length === 0 ? (
            <p className="py-16 text-center text-xs text-muted-foreground">
              {failureMessage(result) ?? "No messages found."}
            </p>
          ) : (
            messages.map((message) => <MessageRow key={message.messageId} message={message} />)
          )}
        </div>
      </ScrollArea>
      <Composer
        account={account}
        canSend={canSend}
        conversation={conversation}
        environmentId={environmentId}
        onSent={refresh}
      />
    </section>
  );
}

function MessageRow({ message }: { readonly message: ChannelMessage }) {
  return (
    <article className="group flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
        {message.sender.displayName.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-xs font-semibold">{message.sender.displayName}</span>
          <time className="text-[10px] text-muted-foreground">{formatTime(message.sentAt)}</time>
        </div>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
          {message.text || <span className="italic text-muted-foreground">Attachment</span>}
        </p>
      </div>
    </article>
  );
}

function Composer({
  account,
  canSend,
  conversation,
  environmentId,
  onSent,
}: {
  readonly account: ConnectedChannelAccount;
  readonly canSend: boolean;
  readonly conversation: ChannelConversation;
  readonly environmentId: EnvironmentId;
  readonly onSent: () => void;
}) {
  const send = useAtomCommand(serverEnvironment.sendChannelMessage, { reportFailure: false });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const content = text.trim();
    if (!content || !canSend) return;
    setSending(true);
    setError(null);
    const result = await send({
      environmentId,
      input: {
        accountId: account.accountId,
        conversationId: conversation.conversationId,
        text: content,
        idempotencyKey: randomUUID(),
      },
    });
    if (result._tag === "Success") {
      setText("");
      onSent();
    } else {
      setError(String(Cause.squash(result.cause)));
    }
    setSending(false);
  };

  return (
    <div className="border-t border-border bg-background p-3">
      {canSend ? (
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-lg border border-border bg-muted/20 p-2 focus-within:border-ring">
            <Textarea
              aria-label={`Message ${conversation.title}`}
              className="max-h-36 min-h-9 resize-none border-0 bg-transparent px-1 py-2 shadow-none focus-visible:ring-0"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={`Message ${conversation.title}`}
              value={text}
            />
            <Button
              aria-label="Send message"
              disabled={sending || text.trim().length === 0}
              onClick={() => void submit()}
              size="icon-sm"
            >
              <ArrowUpIcon className="size-3.5" />
            </Button>
          </div>
          {error ? <p className="mt-1.5 text-xs text-destructive">{error}</p> : null}
        </div>
      ) : (
        <p className="text-center text-[11px] text-muted-foreground">
          This transport mirrors history only. Add an official bot transport to reply from Ditto.
        </p>
      )}
    </div>
  );
}

function EmptyPanel({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-lg border border-border bg-muted/30">
          <InboxIcon className="size-4 text-muted-foreground" />
        </div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
