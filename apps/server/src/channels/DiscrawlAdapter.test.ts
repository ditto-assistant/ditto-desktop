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
        return Effect.succeed({ stdout: '{"messages":12}', stderr: "", code: 0 });
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
