// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - The local channel supervisor owns one bounded native child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

export interface DiscordSidecarStatus {
  readonly protocolVersion: number;
  readonly connected: boolean;
  readonly loginPending: boolean;
  readonly detail: string;
  readonly user?: DiscordSidecarParticipant;
}

export type DiscordSidecarLoginResult =
  | {
      readonly connected: true;
      readonly status: DiscordSidecarStatus;
    }
  | {
      readonly connected: false;
      readonly qrUrl: string;
      readonly expiresInSeconds: number;
    };

export interface DiscordSidecarParticipant {
  readonly id: string;
  readonly displayName: string;
  readonly handle?: string;
  readonly avatarUrl?: string;
  readonly isSelf?: boolean;
  readonly isBot?: boolean;
}

export interface DiscordSidecarConversation {
  readonly id: string;
  readonly title: string;
  readonly kind: "direct" | "group" | "channel" | "thread";
  readonly guildId?: string;
  readonly guildName?: string;
  readonly guildAvatarUrl?: string;
  readonly parentId?: string;
  readonly position?: number;
  readonly lastMessageId?: string;
  readonly latestMessageAt?: string;
  readonly participants?: ReadonlyArray<DiscordSidecarParticipant>;
}

export interface DiscordSidecarMessage {
  readonly id: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly content: string;
  readonly timestamp: string;
  readonly editedAt?: string;
  readonly author: DiscordSidecarParticipant;
  readonly attachments: ReadonlyArray<{
    readonly id: string;
    readonly filename?: string;
    readonly contentType?: string;
    readonly size?: number;
    readonly url?: string;
    readonly proxyUrl?: string;
  }>;
  readonly replyToId?: string;
  readonly nonce?: string;
}

interface SidecarResponse {
  readonly id?: string;
  readonly result?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly event?: string;
  readonly data?: unknown;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class DiscordSidecarClient {
  readonly path: string | undefined;
  readonly stateDir: string | undefined;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #listeners = new Set<(event: string, data: unknown) => void>();
  #child: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
  #restore: Promise<void> | undefined;
  #sequence = 0;

  constructor(path: string | undefined, stateDir?: string) {
    this.path = path;
    this.stateDir = stateDir;
  }

  onEvent(listener: (event: string, data: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async status(): Promise<DiscordSidecarStatus> {
    const status = (await this.#request("status")) as DiscordSidecarStatus;
    if (status.connected || status.loginPending) return status;

    // A QR approval stores the credential before opening the Gateway. If that
    // first connection is interrupted (or the child restarts), account polling
    // must be able to resume from Keychain instead of leaving a spent QR open.
    if (this.#restore === undefined) {
      this.#restore = this.#request("connection.restore", undefined, 30_000)
        .then(() => undefined)
        .finally(() => {
          this.#restore = undefined;
        });
      void this.#restore.catch(() => undefined);
    }
    return status;
  }

  async startLogin(): Promise<DiscordSidecarLoginResult> {
    // Startup restores a Keychain credential in the background. A user can
    // click Connect before that attempt completes; wait for the same restore
    // path so login.start cannot invalidate a valid in-flight connection.
    const restored = (await this.#request(
      "connection.restore",
      undefined,
      30_000,
    )) as DiscordSidecarStatus;
    if (restored.connected) {
      return { connected: true, status: restored };
    }
    return (await this.#request("login.start", undefined, 20_000)) as DiscordSidecarLoginResult;
  }

  async cancelLogin(): Promise<void> {
    await this.#request("login.cancel");
  }

  async logout(): Promise<void> {
    await this.#request("logout");
  }

  async listConversations(): Promise<ReadonlyArray<DiscordSidecarConversation>> {
    return (await this.#request(
      "conversations.list",
      undefined,
      60_000,
    )) as ReadonlyArray<DiscordSidecarConversation>;
  }

  async listMessages(
    channelId: string,
    limit: number,
    beforeId?: string,
  ): Promise<ReadonlyArray<DiscordSidecarMessage>> {
    return (await this.#request("messages.list", {
      channelId,
      limit,
      beforeId,
    })) as ReadonlyArray<DiscordSidecarMessage>;
  }

  async sendMessage(input: {
    readonly channelId: string;
    readonly guildId?: string;
    readonly content: string;
    readonly replyToId?: string;
    readonly attachmentPaths?: ReadonlyArray<string>;
    readonly idempotencyKey: string;
  }): Promise<DiscordSidecarMessage> {
    return (await this.#request("message.send", input, 90_000)) as DiscordSidecarMessage;
  }

  close(): void {
    const child = this.#child;
    this.#child = undefined;
    // The sidecar reads requests until stdin reaches EOF. Closing only with a
    // signal leaves its scanner blocked on the pipe, so close the protocol
    // stream first and let the process unwind cleanly.
    if (child !== undefined && !child.stdin.destroyed) child.stdin.end();
    child?.kill("SIGTERM");
    this.#restore = undefined;
    this.#failPending(new Error("Discord sidecar stopped."));
  }

  async #request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    const child = this.#ensureStarted();
    const id = `discord-${String(++this.#sequence)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Discord sidecar request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`,
        (cause) => {
          if (!cause) return;
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(cause);
        },
      );
    });
  }

  #ensureStarted(): NodeChildProcess.ChildProcessWithoutNullStreams {
    if (this.#child !== undefined && this.#child.exitCode === null) return this.#child;
    if (this.path === undefined || this.path.trim() === "") {
      throw new Error("The Discord protocol sidecar is not bundled in this build.");
    }
    const child = NodeChildProcess.spawn(
      this.path,
      this.stateDir === undefined ? [] : ["--state-dir", this.stateDir],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    this.#child = child;
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    child.once("error", (cause) => this.#failPending(cause));
    child.once("exit", (code, signal) => {
      if (this.#child === child) this.#child = undefined;
      this.#failPending(
        new Error(`Discord sidecar exited (${signal ?? String(code ?? "unknown")}).`),
      );
    });
    // Drain stderr without forwarding it: protocol/auth failures are returned as
    // structured errors, and native stderr must never become a credential log.
    child.stderr.resume();
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
    if (message.error !== undefined) {
      pending.reject(new Error(message.error.message ?? "Discord sidecar request failed."));
    } else {
      pending.resolve(message.result);
    }
  }

  #failPending(cause: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.#pending.clear();
  }
}
