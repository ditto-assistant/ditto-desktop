import type {
  ChannelConversation,
  ChannelMessage,
  ChannelSendMessageInput,
  ChannelSendMessageResult,
  ConnectedChannelAccount,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";

import type { ChannelOperationError } from "@t3tools/contracts";

export interface ChannelCommandInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeout?: Duration.Input | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface ChannelCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}

export type ChannelCommandRun = (
  input: ChannelCommandInput,
) => Effect.Effect<ChannelCommandOutput, ChannelOperationError>;

export interface ChannelAdapter {
  readonly configure?: (
    enabled: boolean,
  ) => Effect.Effect<ConnectedChannelAccount, ChannelOperationError>;
  readonly discover: Effect.Effect<ConnectedChannelAccount, ChannelOperationError>;
  readonly listConversations: Effect.Effect<
    ReadonlyArray<ChannelConversation>,
    ChannelOperationError
  >;
  readonly listMessages: (
    conversationId: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<ChannelMessage>, ChannelOperationError>;
  readonly sendMessage: (
    input: ChannelSendMessageInput,
  ) => Effect.Effect<ChannelSendMessageResult, ChannelOperationError>;
}

export function unknownRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function readString(
  record: Readonly<Record<string, unknown>>,
  ...keys: ReadonlyArray<string>
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

export function readNumber(
  record: Readonly<Record<string, unknown>>,
  ...keys: ReadonlyArray<string>
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function parseJsonRows(stdout: string, keys: ReadonlyArray<string>): ReadonlyArray<unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (Array.isArray(parsed)) return parsed;
  const record = unknownRecord(parsed);
  if (record === null) return [];
  for (const key of keys) {
    const rows = record[key];
    if (Array.isArray(rows)) return rows;
  }
  return [];
}
