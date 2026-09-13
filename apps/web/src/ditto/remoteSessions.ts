/**
 * Remote control of a paired device's session through the Ditto backend.
 *
 * Backend contract (host bridge protocol v1 + v1.1 addendum):
 *
 * - `GET  /api/v5/sessions/{threadId}`            → `DittoRemoteSession` (placement, host, pendingPrompt)
 * - `GET  /api/v5/sessions/{threadId}/commands`   → `{ commands, mode }` (the host's announced catalog)
 * - `POST /api/v5/sessions/{threadId}/turns`      → `{ turnId, status }` with `kind` prompt|command
 * - `POST /api/v5/sessions/{threadId}/interrupt`
 * - `POST /api/v5/sessions/{threadId}/prompts/{promptId}/answer` `{ value }`
 *
 * @module ditto/remoteSessions
 */
import { dittoFetchJson } from "./api";
import type { DittoUser } from "./firebase";
import type { DittoHarness, DittoSessionMode, DittoSessionStatus } from "./hosts";

export type DittoTurnDeliveryStatus = "delivered" | "queued" | "host_offline";

export interface DittoRemotePrompt {
  readonly promptId: string;
  readonly kind: "permission" | "question" | "choice";
  readonly text: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }> | undefined;
  readonly default?: string | undefined;
}

export interface DittoRemoteSession {
  readonly threadId: string;
  readonly sessionId: string;
  readonly title?: string | undefined;
  readonly harness: DittoHarness;
  readonly cwd: string;
  readonly mode: DittoSessionMode;
  readonly status: DittoSessionStatus;
  readonly placement: "local" | "cloud";
  readonly host: {
    readonly id: string;
    readonly name: string;
    readonly presence: "online" | "offline";
  } | null;
  readonly pendingPrompt?: DittoRemotePrompt | null | undefined;
}

export interface DittoSessionCommand {
  readonly name: string;
  readonly description?: string | undefined;
  readonly source: "builtin" | "custom" | "skill" | "plugin";
  readonly argsHint?: string | undefined;
  readonly headless: boolean;
}

export interface DittoSessionCommandCatalog {
  readonly commands: ReadonlyArray<DittoSessionCommand>;
  readonly mode: DittoSessionMode;
}

export async function getDittoRemoteSession(
  user: DittoUser,
  threadId: string,
): Promise<DittoRemoteSession> {
  return dittoFetchJson<DittoRemoteSession>(
    user,
    `/api/v5/sessions/${encodeURIComponent(threadId)}`,
  );
}

export async function listDittoSessionCommands(
  user: DittoUser,
  threadId: string,
): Promise<DittoSessionCommandCatalog> {
  const body = await dittoFetchJson<Partial<DittoSessionCommandCatalog>>(
    user,
    `/api/v5/sessions/${encodeURIComponent(threadId)}/commands`,
  );
  return { commands: body.commands ?? [], mode: body.mode ?? "tui" };
}

export interface DittoTurnRequest {
  readonly text: string;
  readonly attachmentIds?: ReadonlyArray<string> | undefined;
  readonly kind?: "prompt" | "command" | undefined;
  readonly command?: { readonly name: string; readonly args: string } | undefined;
}

export async function submitDittoTurn(
  user: DittoUser,
  threadId: string,
  request: DittoTurnRequest,
): Promise<{ readonly turnId: string; readonly status: DittoTurnDeliveryStatus }> {
  return dittoFetchJson(user, `/api/v5/sessions/${encodeURIComponent(threadId)}/turns`, {
    method: "POST",
    body: {
      text: request.text,
      attachmentIds: request.attachmentIds ?? [],
      kind: request.kind ?? "prompt",
      ...(request.command ? { command: request.command } : {}),
    },
  });
}

export async function interruptDittoTurn(user: DittoUser, threadId: string): Promise<void> {
  await dittoFetchJson<unknown>(
    user,
    `/api/v5/sessions/${encodeURIComponent(threadId)}/interrupt`,
    { method: "POST", body: {} },
  );
}

export async function answerDittoPrompt(
  user: DittoUser,
  threadId: string,
  promptId: string,
  value: string,
): Promise<void> {
  await dittoFetchJson<unknown>(
    user,
    `/api/v5/sessions/${encodeURIComponent(threadId)}/prompts/${encodeURIComponent(promptId)}/answer`,
    { method: "POST", body: { value } },
  );
}

/**
 * `/compact  --focus x` → `{ name: "compact", args: "--focus x" }`; anything
 * that does not start with `/` is a plain prompt.
 */
export function parseSlashCommandInput(
  text: string,
): { readonly name: string; readonly args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([A-Za-z0-9_:.-]+)\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  return { name: match[1]!, args: match[2]!.trim() };
}

/** Skills and custom commands first, builtins after; unsupported headless entries stay listed but disabled. */
export function orderSessionCommands(
  catalog: DittoSessionCommandCatalog,
): ReadonlyArray<DittoSessionCommand & { readonly disabled: boolean }> {
  const rank = (command: DittoSessionCommand) => (command.source === "builtin" ? 1 : 0);
  return catalog.commands
    .toSorted((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name))
    .map((command) => ({
      ...command,
      disabled: catalog.mode === "headless" && !command.headless,
    }));
}
