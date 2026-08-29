import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react";
import type {
  ChannelConversation,
  ChannelMessage,
  ConnectedChannelAccount,
  DiscordAccessibilityReplyResult,
  DiscordAccessibilitySnapshotResult,
  DiscordAccessibilityStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, BotIcon, InboxIcon, RefreshCwIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrl } from "../../assets/assetUrls";
import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { cn, randomUUID } from "../../lib/utils";
import { useVisiblePolling } from "../../hooks/useVisiblePolling";
import { pendingKnowledgePacket, useKnowledgePacketStore } from "../../knowledgePacketStore";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { resolveDiscordMessageText } from "./discordMessageText";
import { mergeDiscordLiveSnapshot } from "./discordLiveMessages";
import { useChannelAccountConnectionStore } from "./channelAccountConnectionStore";

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
const EMPTY_CHANNEL_ACCOUNTS: ReadonlyArray<ConnectedChannelAccount> = [];

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
  const accountsAtom = serverEnvironment.channelAccounts({
    environmentId,
    input: {},
  });
  const accountsResult = useAtomValue(accountsAtom);
  const refreshAccounts = useAtomRefresh(accountsAtom);
  const loadedAccounts = Option.getOrNull(AsyncResult.value(accountsResult))?.accounts;
  const [stableAccounts, setStableAccounts] = useState<ReadonlyArray<ConnectedChannelAccount>>([]);
  const sharedAccounts = useChannelAccountConnectionStore(
    (state) => state.accountsByEnvironment[environmentId] ?? EMPTY_CHANNEL_ACCOUNTS,
  );
  useEffect(() => {
    if (loadedAccounts !== undefined && loadedAccounts.length > 0) {
      setStableAccounts(loadedAccounts);
    }
  }, [loadedAccounts]);
  const accounts = loadedAccounts?.length
    ? loadedAccounts
    : stableAccounts.length > 0
      ? stableAccounts
      : sharedAccounts;
  const syncing = accounts.some((account) => account.state === "syncing");
  useVisiblePolling(refreshAccounts, {
    enabled: syncing || loadedAccounts === undefined || loadedAccounts.length === 0,
    intervalMs: 1_500,
  });
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
  const navigate = useNavigate();
  const attachKnowledgePacket = useKnowledgePacketStore((state) => state.attach);
  const knowledgePacketTarget = useKnowledgePacketStore(
    (state) => state.activeTargetByEnvironment[environmentId],
  );
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
  useVisiblePolling(refresh, {
    enabled: account.service === "discord",
    intervalMs: 3_000,
  });
  const loadedMessages = Option.getOrNull(AsyncResult.value(result))?.messages;
  const sortedLoadedMessages = useMemo(
    () =>
      [...(loadedMessages ?? [])].sort((left, right) => left.sentAt.localeCompare(right.sentAt)),
    [loadedMessages],
  );
  const [stableMessages, setStableMessages] = useState<ReadonlyArray<ChannelMessage>>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [liveSnapshot, setLiveSnapshot] = useState<DiscordAccessibilitySnapshotResult | null>(null);
  const snapshotInFlight = useRef(false);
  useEffect(() => {
    if (loadedMessages !== undefined) {
      setStableMessages(sortedLoadedMessages);
      setLoadingOlder(false);
    }
  }, [loadedMessages, sortedLoadedMessages]);
  const archivedMessages = loadedMessages === undefined ? stableMessages : sortedLoadedMessages;
  const discordAccessibility =
    account.service === "discord" && account.transport !== "discord-local-user"
      ? readLocalApi()?.discordAccessibility
      : undefined;
  const refreshLiveMessages = useCallback(() => {
    if (!discordAccessibility || snapshotInFlight.current) return;
    snapshotInFlight.current = true;
    void discordAccessibility
      .snapshot({
        accountId: account.accountId,
        conversationId: conversation.conversationId,
        conversationTitle: conversation.title,
        maxMessages: 150,
      })
      .then((snapshot) => {
        if (snapshot.targetVerified) setLiveSnapshot(snapshot);
      })
      .finally(() => {
        snapshotInFlight.current = false;
      });
  }, [account.accountId, conversation.conversationId, conversation.title, discordAccessibility]);
  useEffect(() => {
    refreshLiveMessages();
  }, [refreshLiveMessages]);
  useVisiblePolling(refreshLiveMessages, {
    enabled: discordAccessibility !== undefined,
    intervalMs: 3_000,
  });
  const messages = useMemo(
    () => mergeDiscordLiveSnapshot(archivedMessages, account, conversation, liveSnapshot),
    [account, archivedMessages, conversation, liveSnapshot],
  );
  const canSend = account.capabilities.some(
    (capability) =>
      capability.operation === "message.send" && capability.availability === "available",
  );
  const canReplyThroughDiscord = discordAccessibility !== undefined;
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
            {account.service === "discord"
              ? account.transport === "discord-local-user"
                ? "Live on this device · Discrawl archive fallback"
                : canReplyThroughDiscord
                  ? "Device cache · Accessibility reply fallback"
                  : "Device cache · read only"
              : "Messages on this Mac"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            onClick={() => {
              if (!knowledgePacketTarget) return;
              attachKnowledgePacket(
                knowledgePacketTarget,
                pendingKnowledgePacket({
                  accountId: account.accountId,
                  conversationId: conversation.conversationId,
                  label: conversation.title,
                  source: account.service,
                  messageLimit: 50,
                }),
              );
              void navigate({ to: "/" });
            }}
            disabled={!knowledgePacketTarget}
            size="sm"
            title={
              knowledgePacketTarget
                ? "Attach this chat to the most recently active coding task"
                : "Open a coding task before attaching chat context"
            }
            variant="outline"
          >
            <BotIcon className="size-3.5" />
            Use in coding task
          </Button>
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
          <Button
            aria-label="Refresh messages"
            onClick={() => {
              refresh();
              refreshLiveMessages();
            }}
            size="icon-sm"
            variant="ghost"
          >
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
                    conversation={conversation}
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
        onSent={() => {
          refresh();
          refreshLiveMessages();
        }}
      />
    </section>
  );
}

function MessageRow({
  conversation,
  environmentId,
  message,
  showHeader,
}: {
  readonly conversation: ChannelConversation;
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
            {message.attachments.map((attachment) => (
              <DiscordAttachment
                attachment={attachment}
                environmentId={environmentId}
                messageUrl={`discord://-/channels/${conversation.containerId ?? "@me"}/${conversation.conversationId}/${message.messageId}`}
                key={attachment.id}
              />
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function DiscordAttachment({
  attachment,
  environmentId,
  messageUrl,
}: {
  readonly attachment: ChannelMessage["attachments"][number];
  readonly environmentId: EnvironmentId;
  readonly messageUrl: string;
}) {
  if (attachment.cachedAttachmentId) {
    return (
      <CachedDiscordAttachment
        attachment={{
          ...attachment,
          cachedAttachmentId: attachment.cachedAttachmentId,
        }}
        environmentId={environmentId}
      />
    );
  }
  const remoteUrl = attachment.cacheState === "expired" ? undefined : attachment.remoteUrl;
  if (attachment.mediaType?.startsWith("image/") === true && remoteUrl) {
    return <DiscordImage attachment={attachment} url={remoteUrl} />;
  }
  if (attachment.cacheState === "expired") {
    return (
      <Button onClick={() => openExternal(messageUrl)} size="sm" variant="outline">
        <ExternalLinkIcon className="size-3.5" />
        Open message in Discord
      </Button>
    );
  }
  return <DiscordAttachmentButton attachment={attachment} url={remoteUrl} />;
}

function CachedDiscordAttachment({
  attachment,
  environmentId,
}: {
  readonly attachment: ChannelMessage["attachments"][number] & {
    readonly cachedAttachmentId: string;
  };
  readonly environmentId: EnvironmentId;
}) {
  const cachedUrl = useAssetUrl(environmentId, {
    _tag: "attachment",
    attachmentId: attachment.cachedAttachmentId,
    ...(attachment.filename ? { fileName: attachment.filename } : {}),
    ...(attachment.mediaType ? { mimeType: attachment.mediaType } : {}),
  });
  if (attachment.mediaType?.startsWith("image/") === true && cachedUrl) {
    return <DiscordImage attachment={attachment} url={cachedUrl} />;
  }
  return <DiscordAttachmentButton attachment={attachment} url={cachedUrl ?? undefined} />;
}

function DiscordImage({
  attachment,
  url,
}: {
  readonly attachment: ChannelMessage["attachments"][number];
  readonly url: string;
}) {
  return (
    <button
      aria-label={`Open ${attachment.filename ?? "image"}`}
      className="max-w-full overflow-hidden rounded-xl border border-border bg-muted/30"
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
  );
}

function DiscordAttachmentButton({
  attachment,
  url,
}: {
  readonly attachment: ChannelMessage["attachments"][number];
  readonly url: string | undefined;
}) {
  return (
    <Button
      className="max-w-full justify-start"
      disabled={!url}
      onClick={() => url && openExternal(url)}
      size="sm"
      variant="outline"
    >
      <ExternalLinkIcon className="size-3.5" />
      <span className="truncate">{attachment.filename ?? "Open attachment"}</span>
    </Button>
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
  const send = useAtomCommand(serverEnvironment.sendChannelMessage, {
    reportFailure: false,
  });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useAccessibilityFallback, setUseAccessibilityFallback] = useState(false);
  const [accessibilityStatus, setAccessibilityStatus] = useState<DiscordAccessibilityStatus | null>(
    null,
  );
  const [accessibilityResult, setAccessibilityResult] =
    useState<DiscordAccessibilityReplyResult | null>(null);
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const accessibility =
    account.service === "discord" ? readLocalApi()?.discordAccessibility : undefined;
  const canReply = canSend || accessibility !== undefined;

  useEffect(() => {
    if (!accessibility) return;
    let active = true;
    void accessibility.status(false).then((status) => {
      if (active) setAccessibilityStatus(status);
    });
    return () => {
      active = false;
    };
  }, [accessibility]);

  const submit = async () => {
    const content = text.trim();
    if (!content || !canReply) return;
    setSending(true);
    setError(null);
    setAccessibilityResult(null);
    if ((!canSend || useAccessibilityFallback) && accessibility) {
      let permission = accessibilityStatus;
      if (permission?.permission !== "granted") {
        permission = await accessibility.status(true);
        setAccessibilityStatus(permission);
      }
      if (permission.permission !== "granted") {
        setError(permission.detail);
        setSending(false);
        return;
      }
      const actionId = randomUUID();
      setActiveActionId(actionId);
      const replyResult = await accessibility.execute({
        actionId,
        origin: "local_desktop",
        requestedAt: new Date().toISOString(),
        accountId: account.accountId,
        conversationId: conversation.conversationId,
        ...(conversation.containerId ? { containerId: conversation.containerId } : {}),
        conversationTitle: conversation.title,
        text: content,
        mode: "send",
      });
      setActiveActionId(null);
      setAccessibilityResult(replyResult);
      if (replyResult.sent) {
        setText("");
        setUseAccessibilityFallback(false);
        onSent();
      } else if (!replyResult.draftPrepared) {
        setError(replyResult.detail);
      }
      setSending(false);
      return;
    }
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
      {canReply ? (
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
              aria-label={canSend ? "Send message" : "Send through Discord"}
              disabled={sending || text.trim().length === 0}
              onClick={() => void submit()}
              size={canSend ? "icon-sm" : "sm"}
            >
              <ArrowUpIcon className="size-3.5" />
              {!canSend || useAccessibilityFallback ? "Send locally" : null}
            </Button>
          </div>
          {(!canSend || useAccessibilityFallback) &&
          accessibilityStatus?.permission !== "granted" ? (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">
                Allow Accessibility so Ditto can verify this Discord composer and send only when you
                click.
              </p>
              <Button
                onClick={() => {
                  void accessibility?.status(true).then(setAccessibilityStatus);
                }}
                size="sm"
                variant="outline"
              >
                Enable Accessibility
              </Button>
            </div>
          ) : null}
          {canSend && error && accessibility && !useAccessibilityFallback ? (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
              <p className="text-[11px] text-muted-foreground">
                The live send did not return a receipt. Check Discord before using the local UI
                fallback so you don’t send twice.
              </p>
              <Button onClick={() => setUseAccessibilityFallback(true)} size="sm" variant="outline">
                Use local fallback
              </Button>
            </div>
          ) : null}
          {sending && activeActionId && accessibility ? (
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>Verifying the exact Discord conversation…</span>
              <Button
                onClick={() => void accessibility.cancel(activeActionId)}
                size="sm"
                variant="ghost"
              >
                Cancel
              </Button>
            </div>
          ) : null}
          {accessibilityResult?.draftPrepared ? (
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span>{accessibilityResult.detail}</span>
              <Button
                onClick={() => {
                  const scope = conversation.containerId ?? "@me";
                  openExternal(`discord://-/channels/${scope}/${conversation.conversationId}`);
                }}
                size="sm"
                variant="ghost"
              >
                Open Discord
              </Button>
            </div>
          ) : null}
          {accessibilityResult?.sent ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Sent through the verified Discord composer.
            </p>
          ) : null}
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
