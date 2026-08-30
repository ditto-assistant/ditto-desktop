import { ChannelConversationId, ChannelMessageId, ChannelOperationError } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { TelegramChannelSource } from "./TelegramAdapter.ts";
import { makeTelegramProtocolSource } from "./TelegramProtocolSource.ts";
import type { TelegramSidecarClient } from "./TelegramSidecarClient.ts";
import { TelegramSidecarRequestError } from "./TelegramSidecarClient.ts";

const archiveFallback: TelegramChannelSource = {
  discover: Effect.die("unused"),
  listConversations: Effect.succeed([]),
  listMessages: () => Effect.succeed([]),
  sendMessage: () => Effect.die("unused"),
};

describe("TelegramProtocolSource", () => {
  it.effect("returns a QR setup URL and stores no Telegram credential in the renderer", () =>
    Effect.gen(function* () {
      const client = {
        startLogin: vi.fn().mockResolvedValue({
          connected: false,
          qrUrl: "tg://login?token=opaque",
          expiresInSeconds: 30,
        }),
      } as unknown as TelegramSidecarClient;
      const source = makeTelegramProtocolSource(client, archiveFallback);

      const account = yield* source.configure!(true);

      expect(account.state).toBe("syncing");
      expect(account.setupUrl).toBe("tg://login?token=opaque");
    }),
  );

  it.effect("normalizes live dialogs and returns an authoritative send receipt", () =>
    Effect.gen(function* () {
      const client = {
        listConversations: vi.fn().mockResolvedValue([
          {
            id: "user:42",
            title: "Ada",
            kind: "direct",
            participants: [{ id: "42", displayName: "Ada" }],
            latestMessageAt: "2026-08-30T12:00:00Z",
          },
        ]),
        sendMessage: vi.fn().mockResolvedValue({
          id: "9001",
          channelId: "user:42",
          content: "hello",
          timestamp: "2026-08-30T12:01:00Z",
          author: { id: "7", displayName: "Me", isSelf: true },
          attachments: [],
        }),
      } as unknown as TelegramSidecarClient;
      const source = makeTelegramProtocolSource(client, archiveFallback);

      const conversations = yield* source.listConversations;
      const sent = yield* source.sendMessage({
        accountId: "telegram:desktop:local" as never,
        conversationId: ChannelConversationId.make("user:42"),
        text: "hello",
        idempotencyKey: "action-1",
      });

      expect(conversations[0]?.title).toBe("Ada");
      expect(sent.message.messageId).toBe(ChannelMessageId.make("9001"));
      expect(sent.transport).toBe("telegram-desktop-local");
    }),
  );

  it.effect("falls back to the accessibility archive for reads without retrying sends", () =>
    Effect.gen(function* () {
      const fallback: TelegramChannelSource = {
        ...archiveFallback,
        listConversations: Effect.succeed([
          {
            accountId: "telegram:desktop:local" as never,
            conversationId: ChannelConversationId.make("archive:1"),
            service: "telegram",
            title: "Archive chat",
            kind: "direct",
            participants: [],
            completeness: "device_cache_partial",
          },
        ]),
      };
      const client = {
        listConversations: vi
          .fn()
          .mockRejectedValue(
            new TelegramSidecarRequestError("not_connected", "sensitive child detail"),
          ),
      } as unknown as TelegramSidecarClient;

      const conversations = yield* makeTelegramProtocolSource(client, fallback).listConversations;

      expect(conversations.map((value) => value.title)).toEqual(["Archive chat"]);
    }),
  );

  it.effect("returns a typed stable send error without leaking sidecar details", () =>
    Effect.gen(function* () {
      const client = {
        sendMessage: vi
          .fn()
          .mockRejectedValue(
            new TelegramSidecarRequestError("operation_failed", "sensitive child detail"),
          ),
      } as unknown as TelegramSidecarClient;
      const source = makeTelegramProtocolSource(client, archiveFallback);

      const error = yield* Effect.flip(
        source.sendMessage({
          accountId: "telegram:desktop:local" as never,
          conversationId: ChannelConversationId.make("user:42"),
          text: "hello",
          idempotencyKey: "action-2",
        }),
      );

      expect(error).toBeInstanceOf(ChannelOperationError);
      expect(error.operation).toBe("message.send");
      expect(error.kind).toBe("transport_failed");
      expect(error.message).toBe("Telegram message send failed on this device.");
      expect(error.message).not.toContain("sensitive child detail");
    }),
  );
});
