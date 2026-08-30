import { ChannelConversationId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ChannelCommandRun } from "./ChannelAdapter.ts";
import { makeDiscrawlAdapter } from "./DiscrawlAdapter.ts";

it.effect("discovers Discrawl and normalizes guild and DM conversations", () =>
  Effect.gen(function* () {
    const commands: Array<ReadonlyArray<string>> = [];
    const run: ChannelCommandRun = (input) => {
      commands.push(input.args);
      if (input.args.includes("status")) {
        return Effect.succeed({
          stdout: '{"messages":12}',
          stderr: "",
          code: 0,
        });
      }
      if (input.args.includes("channels")) {
        return Effect.succeed({
          stdout: '{"channels":[{"id":"guild-1","name":"general","guild_id":"guild"}]}',
          stderr: "",
          code: 0,
        });
      }
      return Effect.succeed({
        stdout: '{"conversations":[{"channel_id":"dm-1","name":"Peyton","guild_id":"@me"}]}',
        stderr: "",
        code: 0,
      });
    };

    const adapter = makeDiscrawlAdapter(run);
    const account = yield* adapter.discover;
    const conversations = yield* adapter.listConversations;

    expect(account.state).toBe("ready");
    expect(account.identityMode).toBe("archive");
    expect(conversations.map((conversation) => conversation.title)).toEqual(["general", "Peyton"]);
    expect(conversations[1]?.kind).toBe("direct");
    expect(commands).toContainEqual(["--json", "status"]);
  }),
);

it.effect("deduplicates overlapping Desktop channel and DM catalogs", () =>
  Effect.gen(function* () {
    const run: ChannelCommandRun = (input) => {
      if (input.args.includes("channels")) {
        return Effect.succeed({
          stdout: JSON.stringify([{ id: "dm-1", name: "Peyton", guild_id: "@me", kind: "dm" }]),
          stderr: "",
          code: 0,
        });
      }
      if (input.args.includes("dms")) {
        return Effect.succeed({
          stdout: JSON.stringify([
            {
              channel_id: "dm-1",
              name: "Peyton",
              guild_id: "@me",
              last_message_at: "2026-08-29T00:00:00.000Z",
            },
          ]),
          stderr: "",
          code: 0,
        });
      }
      return Effect.succeed({
        stdout: '{"columns":[],"rows":[]}',
        stderr: "",
        code: 0,
      });
    };

    const conversations = yield* makeDiscrawlAdapter(run).listConversations;

    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.conversationId).toBe("dm-1");
    expect(conversations[0]?.latestMessageAt).toBe("2026-08-29T00:00:00.000Z");
  }),
);

it.effect("never exposes personal Discord sending through Discrawl", () =>
  Effect.gen(function* () {
    const adapter = makeDiscrawlAdapter(() =>
      Effect.succeed({ stdout: "{}", stderr: "", code: 0 }),
    );

    const result = yield* Effect.result(
      adapter.sendMessage({
        accountId: "discord:discrawl:local" as never,
        conversationId: ChannelConversationId.make("guild-1"),
        text: "hello",
        idempotencyKey: "request-1",
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.kind).toBe("capability_unavailable");
    }
  }),
);

it.effect("joins attachments and identifies the local Discord author", () =>
  Effect.gen(function* () {
    const run: ChannelCommandRun = (input) => {
      if (input.args.includes("messages")) {
        return Effect.succeed({
          stdout: JSON.stringify({
            messages: [
              {
                id: "message-1",
                channel_id: "123",
                author_id: "111",
                author_name: "Peyton",
                content: "photo",
                timestamp: "2026-08-28T00:00:00.000Z",
              },
            ],
          }),
          stderr: "",
          code: 0,
        });
      }
      if (input.args.includes("attachments")) {
        return Effect.succeed({
          stdout: JSON.stringify({
            attachments: [
              {
                attachment_id: "attachment-1",
                message_id: "message-1",
                filename: "image.png",
                content_type: "image/png",
                proxy_url: "https://cdn.discordapp.com/image.png",
              },
            ],
          }),
          stderr: "",
          code: 0,
        });
      }
      return Effect.succeed({
        stdout: JSON.stringify({ columns: ["author_id"], rows: [["111"]] }),
        stderr: "",
        code: 0,
      });
    };

    const adapter = makeDiscrawlAdapter(run);
    const messages = yield* adapter.listMessages(ChannelConversationId.make("123"), 150);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.sender.isSelf).toBe(true);
    expect(messages[0]?.attachments).toEqual([
      {
        id: "attachment-1",
        filename: "image.png",
        mediaType: "image/png",
        remoteUrl: "https://cdn.discordapp.com/image.png",
      },
    ]);
  }),
);

it.effect("resolves Discord user and channel mentions with one bounded lookup", () =>
  Effect.gen(function* () {
    const sqlQueries: Array<string> = [];
    const run: ChannelCommandRun = (input) => {
      if (input.args.includes("messages")) {
        return Effect.succeed({
          stdout: JSON.stringify({
            messages: [
              {
                id: "message-1",
                channel_id: "123",
                author_id: "111",
                author_name: "Peyton",
                content: "Hi <@222> in <#333>",
                timestamp: "2026-08-28T00:00:00.000Z",
              },
            ],
          }),
          stderr: "",
          code: 0,
        });
      }
      if (input.args.includes("attachments")) {
        return Effect.succeed({
          stdout: '{"attachments":[]}',
          stderr: "",
          code: 0,
        });
      }
      const query = input.args.at(-1) ?? "";
      sqlQueries.push(query);
      if (query.includes("UNION ALL")) {
        return Effect.succeed({
          stdout: JSON.stringify({
            columns: ["kind", "id", "display_name"],
            rows: [
              ["user", "222", "Omar"],
              ["channel", "333", "product-dev"],
            ],
          }),
          stderr: "",
          code: 0,
        });
      }
      return Effect.succeed({
        stdout: JSON.stringify({ columns: ["author_id"], rows: [["111"]] }),
        stderr: "",
        code: 0,
      });
    };

    const adapter = makeDiscrawlAdapter(run);
    const messages = yield* adapter.listMessages(ChannelConversationId.make("123"), 150);

    expect(messages[0]?.resolvedMentions).toEqual([
      { id: "222", kind: "user", displayName: "Omar" },
      { id: "333", kind: "channel", displayName: "product-dev" },
    ]);
    expect(sqlQueries.filter((query) => query.includes("UNION ALL"))).toHaveLength(1);
  }),
);

it.effect("keeps Discord local sync off until the user enables it", () =>
  Effect.gen(function* () {
    let enabled = false;
    const adapter = makeDiscrawlAdapter({
      configure: (next) => Effect.sync(() => void (enabled = next)),
      ensureContinuousSync: () => Effect.void,
      execute: () => Effect.succeed({ stdout: "{}", stderr: "", code: 0 }),
      getSyncState: () => Effect.succeed({ state: "idle" }),
      isDiscordInstalled: () => Effect.succeed(true),
      isEnabled: () => Effect.sync(() => enabled),
    });

    const disabledAccount = yield* adapter.discover;
    expect(disabledAccount.enabled).toBe(false);
    expect(disabledAccount.state).toBe("setup_required");

    const configure = adapter.configure;
    expect(configure).toBeDefined();
    if (configure === undefined) return;
    const enabledAccount = yield* configure(true);
    expect(enabledAccount.enabled).toBe(true);
    expect(enabledAccount.state).toBe("ready");
  }),
);

it.effect("reports background Discord setup without probing the archive", () =>
  Effect.gen(function* () {
    let executeCount = 0;
    const adapter = makeDiscrawlAdapter({
      configure: () => Effect.void,
      ensureContinuousSync: () => Effect.void,
      execute: () =>
        Effect.sync(() => {
          executeCount += 1;
          return { stdout: "{}", stderr: "", code: 0 };
        }),
      getSyncState: () => Effect.succeed({ state: "syncing" }),
      isDiscordInstalled: () => Effect.succeed(true),
      isEnabled: () => Effect.succeed(true),
    });

    const account = yield* adapter.discover;

    expect(account.state).toBe("syncing");
    expect(account.statusDetail).toBe("Connecting to Discord…");
    expect(executeCount).toBe(0);
  }),
);
