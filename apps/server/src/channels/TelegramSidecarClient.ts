// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns one bounded native child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

export interface TelegramSidecarParticipant {
  readonly id: string;
  readonly displayName: string;
  readonly handle?: string;
  readonly isSelf?: boolean;
}

export interface TelegramSidecarStatus {
  readonly protocolVersion: number;
  readonly configured: boolean;
  readonly connected: boolean;
  readonly loginPending: boolean;
  readonly detail: string;
  readonly user?: TelegramSidecarParticipant;
}

export type TelegramSidecarLoginResult =
  | { readonly connected: true; readonly status: TelegramSidecarStatus }
  | {
      readonly connected: false;
      readonly qrUrl: string;
      readonly expiresInSeconds: number;
    };

export interface TelegramSidecarConversation {
  readonly id: string;
  readonly title: string;
  readonly kind: "direct" | "group" | "channel" | "thread";
  readonly latestMessageAt?: string;
  readonly participants: ReadonlyArray<TelegramSidecarParticipant>;
}

export interface TelegramSidecarMessage {
  readonly id: string;
  readonly channelId: string;
  readonly content: string;
  readonly timestamp: string;
  readonly author: TelegramSidecarParticipant;
  readonly replyToId?: string;
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly filename?: string;
    readonly size?: number;
  }>;
}

interface SidecarResponse {
  readonly id?: string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
  readonly event?: string;
  readonly data?: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class TelegramSidecarClient {
  readonly #path: string | undefined;
  readonly #stateDir: string | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(event: string, data: unknown) => void>();
  #child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  #sequence = 0;

  constructor(path: string | undefined, stateDir?: string) {
    this.#path = path;
    this.#stateDir = stateDir;
  }

  onEvent(listener: (event: string, data: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  status(): Promise<TelegramSidecarStatus> {
    return this.#request("status") as Promise<TelegramSidecarStatus>;
  }

  restore(): Promise<TelegramSidecarStatus> {
    return this.#request("connection.restore", undefined, 30_000) as Promise<TelegramSidecarStatus>;
  }

  startLogin(): Promise<TelegramSidecarLoginResult> {
    return this.#request("login.start", undefined, 30_000) as Promise<TelegramSidecarLoginResult>;
  }

  logout(): Promise<void> {
    return this.#request("logout").then(() => undefined);
  }

  listConversations(): Promise<ReadonlyArray<TelegramSidecarConversation>> {
    return this.#request("conversations.list", undefined, 90_000) as Promise<
      ReadonlyArray<TelegramSidecarConversation>
    >;
  }

  listMessages(channelId: string, limit: number): Promise<ReadonlyArray<TelegramSidecarMessage>> {
    return this.#request("messages.list", { channelId, limit }, 90_000) as Promise<
      ReadonlyArray<TelegramSidecarMessage>
    >;
  }

  sendMessage(input: {
    readonly channelId: string;
    readonly content: string;
    readonly idempotencyKey: string;
  }): Promise<TelegramSidecarMessage> {
    return this.#request("message.send", input, 90_000) as Promise<TelegramSidecarMessage>;
  }

  close(): void {
    const child = this.#child;
    this.#child = undefined;
    if (child !== undefined && !child.stdin.destroyed) child.stdin.end();
    child?.kill("SIGTERM");
    this.#failPending(new Error("Telegram sidecar stopped."));
  }

  #request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    const child = this.#ensureStarted();
    const id = `telegram-${String(++this.#sequence)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Telegram sidecar request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  }

  #ensureStarted(): NodeChildProcess.ChildProcessWithoutNullStreams {
    if (this.#child !== undefined && this.#child.exitCode === null) return this.#child;
    if (this.#path === undefined || this.#path.trim() === "") {
      throw new Error("The Telegram protocol sidecar is not bundled in this build.");
    }
    const child = NodeChildProcess.spawn(
      this.#path,
      this.#stateDir === undefined ? [] : ["--state-dir", this.#stateDir],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          DITTO_TELEGRAM_API_ID: process.env.DITTO_TELEGRAM_API_ID,
          DITTO_TELEGRAM_API_HASH: process.env.DITTO_TELEGRAM_API_HASH,
        },
      },
    );
    this.#child = child;
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) =>
      this.#handleLine(line),
    );
    child.stderr.resume();
    child.once("error", (cause) => this.#failPending(cause));
    child.once("exit", (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      this.#failPending(
        new Error(`Telegram sidecar exited (${signal ?? String(code ?? "unknown")}).`),
      );
    });
    return child;
  }

  #handleLine(line: string): void {
    let message: SidecarResponse;
    try {
      message = JSON.parse(line) as SidecarResponse;
    } catch {
      return;
    }
    if (message.event !== undefined) {
      for (const listener of this.#listeners) listener(message.event, message.data);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if (message.error !== undefined)
      pending.reject(new Error(message.error.message ?? "Telegram sidecar failed."));
    else pending.resolve(message.result);
  }

  #failPending(cause: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.#pending.clear();
  }
}
