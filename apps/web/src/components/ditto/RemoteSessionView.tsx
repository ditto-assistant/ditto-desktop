/**
 * Remote control of a session running on a paired device.
 *
 * The composer posts turns to the Ditto backend, which forwards them to the
 * host over its device-link socket (host bridge protocol v1/v1.1). Typing `/`
 * offers the host's announced command catalog; a pending permission or
 * question renders as a card above the composer.
 *
 * @module RemoteSessionView
 */
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, SendIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import type { DittoUser } from "~/ditto/firebase";
import {
  answerDittoPrompt,
  getDittoRemoteSession,
  interruptDittoTurn,
  listDittoSessionCommands,
  orderSessionCommands,
  parseSlashCommandInput,
  submitDittoTurn,
  type DittoRemoteSession,
  type DittoSessionCommandCatalog,
  type DittoTurnDeliveryStatus,
} from "~/ditto/remoteSessions";
import { useDittoUser } from "~/ditto/useDittoUser";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

const SESSION_POLL_INTERVAL_MS = 3_000;

function describeDelivery(status: DittoTurnDeliveryStatus): string {
  switch (status) {
    case "delivered":
      return "Delivered to the host.";
    case "queued":
      return "Queued until the host reconnects.";
    case "host_offline":
      return "The host is offline; the turn will be delivered when it returns.";
  }
}

function PendingPromptCard({
  session,
  user,
  onAnswered,
}: {
  readonly session: DittoRemoteSession;
  readonly user: DittoUser;
  readonly onAnswered: () => void;
}) {
  const prompt = session.pendingPrompt;
  const [value, setValue] = useState(prompt?.default ?? "");
  const [busy, setBusy] = useState(false);
  if (!prompt) return null;

  const answer = async (chosen: string) => {
    setBusy(true);
    try {
      await answerDittoPrompt(user, session.threadId, prompt.promptId, chosen);
      onAnswered();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-warning/40 bg-warning/8 p-3 text-sm">
      <p className="mb-2 font-medium">
        {prompt.kind === "permission" ? "Permission requested" : "The agent is asking"}
      </p>
      <p className="mb-3 whitespace-pre-wrap text-muted-foreground">{prompt.text}</p>
      {prompt.options && prompt.options.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {prompt.options.map((option) => (
            <Button
              key={option.id}
              type="button"
              size="sm"
              variant={option.id === prompt.default ? "default" : "outline"}
              disabled={busy}
              onClick={() => void answer(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void answer(value);
          }}
        >
          <Input value={value} onChange={(event) => setValue(event.target.value)} />
          <Button type="submit" size="sm" disabled={busy || value.trim().length === 0}>
            Answer
          </Button>
        </form>
      )}
    </div>
  );
}

function CommandPalette({
  catalog,
  query,
  onPick,
}: {
  readonly catalog: DittoSessionCommandCatalog;
  readonly query: string;
  readonly onPick: (name: string) => void;
}) {
  const ordered = useMemo(() => orderSessionCommands(catalog), [catalog]);
  const filtered = ordered.filter((command) => command.name.startsWith(query));
  if (filtered.length === 0) return null;
  return (
    <ul className="max-h-56 overflow-y-auto rounded-md border bg-popover p-1 text-sm">
      {filtered.map((command) => (
        <li key={command.name}>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent disabled:opacity-50"
            disabled={command.disabled}
            onClick={() => onPick(command.name)}
          >
            <span className="font-mono">/{command.name}</span>
            {command.argsHint ? (
              <span className="font-mono text-muted-foreground">{command.argsHint}</span>
            ) : null}
            <span className="ml-auto truncate text-xs text-muted-foreground">
              {command.disabled
                ? "not available headless"
                : (command.description ?? command.source)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RemoteSessionBody({
  user,
  hostId,
  threadId,
}: {
  readonly user: DittoUser;
  readonly hostId: string;
  readonly threadId: string;
}) {
  const navigate = useNavigate();
  const [session, setSession] = useState<DittoRemoteSession | null>(null);
  const [catalog, setCatalog] = useState<DittoSessionCommandCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSession(await getDittoRemoteSession(user, threadId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [threadId, user]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), SESSION_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void listDittoSessionCommands(user, threadId)
      .then((loaded) => {
        if (!cancelled) setCatalog(loaded);
      })
      .catch(() => {
        // The catalog is optional; the composer still sends prompts.
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, user]);

  const send = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      setSending(true);
      setNotice(null);
      try {
        const command = parseSlashCommandInput(trimmed);
        const result = await submitDittoTurn(
          user,
          threadId,
          command ? { text: trimmed, kind: "command", command } : { text: trimmed },
        );
        setText("");
        setNotice(describeDelivery(result.status));
        void refresh();
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSending(false);
      }
    },
    [refresh, text, threadId, user],
  );

  const interrupt = useCallback(async () => {
    try {
      await interruptDittoTurn(user, threadId);
      setNotice("Interrupt sent.");
      void refresh();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [refresh, threadId, user]);

  const slashQuery = text.startsWith("/") && !text.includes(" ") ? text.slice(1) : null;
  const hostOffline = session?.host?.presence === "offline";

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="compact"
          variant="ghost"
          onClick={() => void navigate({ to: "/settings/devices" })}
        >
          <ArrowLeftIcon className="size-3.5" />
          Devices
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">
          {session?.title ?? session?.cwd ?? threadId}
        </h1>
        {session ? (
          <>
            <Badge variant="outline" size="sm">
              {session.harness} · {session.mode}
            </Badge>
            <Badge variant={session.status === "running" ? "info" : "outline"} size="sm">
              {session.status}
            </Badge>
            <Badge variant={hostOffline ? "warning" : "success"} size="sm">
              {session.host?.name ?? hostId} · {session.host?.presence ?? "unknown"}
            </Badge>
          </>
        ) : null}
      </div>

      {error !== null ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      {session === null && error === null ? <Spinner /> : null}

      <div className="flex-1" />

      {session ? (
        <PendingPromptCard
          key={session.pendingPrompt?.promptId ?? "none"}
          session={session}
          user={user}
          onAnswered={() => void refresh()}
        />
      ) : null}

      {slashQuery !== null && catalog ? (
        <CommandPalette
          catalog={catalog}
          query={slashQuery}
          onPick={(name) => setText(`/${name} `)}
        />
      ) : null}

      <form className="flex items-center gap-2" onSubmit={(event) => void send(event)}>
        <Input
          aria-label="Message to the remote session"
          placeholder={
            hostOffline ? "Host offline — turns are queued" : "Send a turn, or / for commands"
          }
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={sending}
        />
        {session?.status === "running" ? (
          <Button type="button" size="sm" variant="outline" onClick={() => void interrupt()}>
            <SquareIcon className="size-3.5" />
            Stop
          </Button>
        ) : null}
        <Button type="submit" size="sm" disabled={sending || text.trim().length === 0}>
          {sending ? <Spinner /> : <SendIcon className="size-3.5" />}
          Send
        </Button>
      </form>
      {notice !== null ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
    </div>
  );
}

export function RemoteSessionView({
  hostId,
  threadId,
}: {
  readonly hostId: string;
  readonly threadId: string;
}) {
  const { ready, user } = useDittoUser();
  if (!ready) return <Spinner />;
  if (user === null) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Sign in with your Ditto account to control sessions on paired devices.
      </p>
    );
  }
  return <RemoteSessionBody user={user} hostId={hostId} threadId={threadId} />;
}
