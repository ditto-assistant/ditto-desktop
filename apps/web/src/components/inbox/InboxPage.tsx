import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react";
import type {
  ChannelConversation,
  ChannelMessage,
  ConnectedChannelAccount,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { ArrowUpIcon, InboxIcon, RefreshCwIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { cn, randomUUID } from "../../lib/utils";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { resolveDiscordMessageText } from "./discordMessageText";

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

const KEEP_VIRTUAL_LIST_POSITION = { data: true, size: true } as const;

function openExternal(url: string) {
  const request = readLocalApi()?.shell.openExternal(url);
  if (request !== undefined) void request.catch(() => undefined);
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

export function InboxPage({
  accountId,
  conversationId,
}: {
  readonly accountId: string | undefined;
  readonly conversationId: string | undefined;
}) {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  return environmentId === null ? (
    <InboxFrame>
      <EmptyPanel title="No local device connected" detail="Connect this desktop to open Inbox." />
    </InboxFrame>
  ) : (
    <ConnectedInbox
      accountId={accountId}
      conversationId={conversationId}
      environmentId={environmentId}
    />
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

function ConnectedInbox({
  accountId,
  conversationId,
  environmentId,
}: {
  readonly accountId: string | undefined;
  readonly conversationId: string | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const accountsAtom = serverEnvironment.channelAccounts({ environmentId, input: {} });
  const accountsResult = useAtomValue(accountsAtom);
  const refreshAccounts = useAtomRefresh(accountsAtom);
  const loadedAccounts = Option.getOrNull(AsyncResult.value(accountsResult))?.accounts;
  const [stableAccounts, setStableAccounts] = useState<ReadonlyArray<ConnectedChannelAccount>>([]);
  useEffect(() => {
    if (loadedAccounts !== undefined && loadedAccounts.length > 0) {
      setStableAccounts(loadedAccounts);
    }
  }, [loadedAccounts]);
  const accounts = loadedAccounts?.length ? loadedAccounts : stableAccounts;
  const syncing = accounts.some((account) => account.state === "syncing");
  useEffect(() => {
    if (!syncing) return;
    const interval = window.setInterval(refreshAccounts, 1_500);
    return () => window.clearInterval(interval);
  }, [refreshAccounts, syncing]);
  const selectedAccount =
    accounts.find((account) => account.accountId === accountId) ?? accounts[0] ?? null;

  return (
    <InboxFrame>
      {selectedAccount === null ? (
        <EmptyPanel
          title="Looking for local chats"
          detail="Discord and Messages accounts will appear here when this device reports them."
        />
      ) : (
        <ConversationWorkspace
          account={selectedAccount}
          environmentId={environmentId}
          requestedConversationId={conversationId}
        />
      )}
    </InboxFrame>
  );
}

function ConversationWorkspace({
  account,
  environmentId,
  requestedConversationId,
}: {
  readonly account: ConnectedChannelAccount;
  readonly environmentId: EnvironmentId;
  readonly requestedConversationId: string | undefined;
}) {
  if (!account.enabled || account.state !== "ready") {
    return <EmptyPanel title={account.label} detail={accountStatus(account)} />;
  }

  return (
    <ReadyConversationWorkspace
      account={account}
      environmentId={environmentId}
      requestedConversationId={requestedConversationId}
    />
  );
}

function ReadyConversationWorkspace({
  account,
  environmentId,
  requestedConversationId,
}: {
  readonly account: ConnectedChannelAccount;
  readonly environmentId: EnvironmentId;
  readonly requestedConversationId: string | undefined;
}) {
  const conversationsAtom = serverEnvironment.channelConversations({
    environmentId,
    input: { accountId: account.accountId },
  });
  const result = useAtomValue(conversationsAtom);
  const loadedConversations = Option.getOrNull(AsyncResult.value(result))?.conversations;
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
  const selected = conversations.find(
    (conversation) => conversation.conversationId === requestedConversationId,
  );
  return selected === undefined ? (
    <EmptyPanel title="No conversation selected" detail="Choose a chat from the sidebar." />
  ) : (
    <MessagePanel
      key={selected.conversationId}
      account={account}
      conversation={selected}
      environmentId={environmentId}
    />
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
  const [messageLimit, setMessageLimit] = useState(150);
  const messagesAtom = serverEnvironment.channelMessages({
    environmentId,
    input: {
      accountId: account.accountId,
      conversationId: conversation.conversationId,
      limit: messageLimit,
    },
  });
  const result = useAtomValue(messagesAtom);
  const refresh = useAtomRefresh(messagesAtom);
  const loadedMessages = Option.getOrNull(AsyncResult.value(result))?.messages;
  const sortedLoadedMessages = useMemo(
    () =>
      [...(loadedMessages ?? [])].sort((left, right) => left.sentAt.localeCompare(right.sentAt)),
    [loadedMessages],
  );
  const [stableMessages, setStableMessages] = useState<ReadonlyArray<ChannelMessage>>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    if (loadedMessages !== undefined) {
      setStableMessages(sortedLoadedMessages);
      setLoadingOlder(false);
    }
  }, [loadedMessages, sortedLoadedMessages]);
  const messages = loadedMessages === undefined ? stableMessages : sortedLoadedMessages;
  const canSend = account.capabilities.some(
    (capability) =>
      capability.operation === "message.send" && capability.availability === "available",
  );
  const canLoadOlder = messages.length >= messageLimit && messageLimit < 5_000;
  const loadOlder = useCallback(() => {
    if (!canLoadOlder || loadingOlder) return;
    setLoadingOlder(true);
    setMessageLimit((current) => Math.min(current + 250, 5_000));
  }, [canLoadOlder, loadingOlder]);

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{conversation.title}</p>
          <p className="text-[10px] text-muted-foreground">
            {account.service === "discord" ? "Device cache · read only" : "Messages on this Mac"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {account.service === "discord" ? (
            <Button
              onClick={() => {
                const scope = conversation.containerId ?? "@me";
                openExternal(`discord://-/channels/${scope}/${conversation.conversationId}`);
              }}
              size="sm"
              variant="ghost"
            >
              <ExternalLinkIcon className="size-3.5" />
              Open in Discord
            </Button>
          ) : null}
          <Button aria-label="Refresh messages" onClick={refresh} size="icon-sm" variant="ghost">
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {messages.length === 0 ? (
          <p className="py-16 text-center text-xs text-muted-foreground">
            {failureMessage(result) ?? "No messages found."}
          </p>
        ) : (
          <LegendList<ChannelMessage>
            className="h-full min-h-0 overflow-x-hidden overscroll-y-contain px-5"
            data={messages}
            estimatedItemSize={72}
            initialScrollAtEnd
            keyExtractor={(message) => message.messageId}
            maintainVisibleContentPosition={KEEP_VIRTUAL_LIST_POSITION}
            onScroll={(event) => {
              if (event.nativeEvent.contentOffset.y <= 96) loadOlder();
            }}
            renderItem={({ item: message, index }) => {
              const previous = messages[index - 1];
              const previousSentAt =
                previous === undefined ? Number.NaN : Date.parse(previous.sentAt);
              const sentAt = Date.parse(message.sentAt);
              const showHeader =
                previous === undefined ||
                previous.sender.id !== message.sender.id ||
                !Number.isFinite(previousSentAt) ||
                !Number.isFinite(sentAt) ||
                sentAt - previousSentAt > 7 * 60_000;
              return (
                <div className={cn("mx-auto w-full max-w-3xl", showHeader ? "pt-4" : "pt-0.5")}>
                  <MessageRow
                    environmentId={environmentId}
                    message={message}
                    showHeader={showHeader}
                  />
                </div>
              );
            }}
            ListHeaderComponent={
              <div className="flex h-8 items-center justify-center text-[11px] text-muted-foreground">
                {loadingOlder ? "Loading earlier messages…" : null}
              </div>
            }
            ListFooterComponent={<div className="h-4" />}
          />
        )}
      </div>
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

function MessageRow({
  environmentId,
  message,
  showHeader,
}: {
  readonly environmentId: EnvironmentId;
  readonly message: ChannelMessage;
  readonly showHeader: boolean;
}) {
  const resolvedText = resolveDiscordMessageText(message.text, message.resolvedMentions);
  return (
    <article className="group flex min-w-0 gap-3 px-2 py-0.5 hover:bg-muted/20">
      {showHeader ? (
        <ParticipantAvatar
          avatarUrl={message.sender.avatarUrl}
          displayName={message.sender.displayName}
        />
      ) : (
        <time className="invisible w-8 shrink-0 pt-1 text-right text-[9px] text-muted-foreground group-hover:visible">
          {formatTime(message.sentAt)}
        </time>
      )}
      <div className="min-w-0 flex-1">
        {showHeader ? (
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold">{message.sender.displayName}</span>
            <time className="shrink-0 text-[10px] text-muted-foreground">
              {formatTime(message.sentAt)}
            </time>
          </div>
        ) : null}
        {resolvedText ? (
          <ChatMarkdown
            className="text-foreground [&_p]:my-0 [&_table]:my-2"
            cwd={undefined}
            environmentId={environmentId}
            lineBreaks
            parseRawHtml={false}
            text={resolvedText}
          />
        ) : null}
        {message.attachments.length > 0 ? (
          <div className="mt-1.5 flex max-w-full flex-col items-start gap-1.5">
            {message.attachments.map((attachment) => {
              const url = attachment.remoteUrl;
              const isImage = attachment.mediaType?.startsWith("image/") === true;
              return isImage && url ? (
                <button
                  aria-label={`Open ${attachment.filename ?? "image"}`}
                  className="max-w-full overflow-hidden rounded-xl border border-border bg-muted/30"
                  key={attachment.id}
                  onClick={() => openExternal(url)}
                  type="button"
                >
                  <img
                    alt={attachment.filename ?? "Discord image"}
                    className="max-h-96 max-w-full object-contain"
                    loading="lazy"
                    src={url}
                  />
                </button>
              ) : (
                <Button
                  className="max-w-full justify-start"
                  disabled={!url}
                  key={attachment.id}
                  onClick={() => url && openExternal(url)}
                  size="sm"
                  variant="outline"
                >
                  <ExternalLinkIcon className="size-3.5" />
                  <span className="truncate">{attachment.filename ?? "Open attachment"}</span>
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function ParticipantAvatar({
  avatarUrl,
  displayName,
}: {
  readonly avatarUrl: string | undefined;
  readonly displayName: string;
}) {
  const initials = displayName.trim().slice(0, 2).toUpperCase() || "?";
  return avatarUrl ? (
    <img
      alt=""
      className="mt-0.5 size-8 shrink-0 rounded-full bg-muted object-cover"
      loading="lazy"
      src={avatarUrl}
    />
  ) : (
    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
      {initials}
    </div>
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
          Replies from Ditto aren’t enabled for this connection yet.
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
