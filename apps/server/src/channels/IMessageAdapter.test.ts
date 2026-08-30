import { ChannelConversationId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { ChannelCommandInput, ChannelCommandRun } from "./ChannelAdapter.ts";
import { IMESSAGE_ACCOUNT_ID, makeIMessageAdapter } from "./IMessageAdapter.ts";

it.effect("reports iMessage unavailable without invoking commands off macOS", () =>
  Effect.gen(function* () {
    let invoked = false;
    const adapter = makeIMessageAdapter(
      () => {
        invoked = true;
        return Effect.succeed({ stdout: "", stderr: "", code: 0 });
      },
      { platform: "linux", homeDirectory: "/tmp" },
    );

    const account = yield* adapter.discover;
    expect(account.state).toBe("unavailable");
    expect(invoked).toBe(false);
  }),
);

it.effect("passes message text as an osascript argument instead of interpolating it", () =>
  Effect.gen(function* () {
    let invocation: ChannelCommandInput | undefined;
    const run: ChannelCommandRun = (input) => {
      invocation = input;
      return Effect.succeed({ stdout: "", stderr: "", code: 0 });
    };
    const adapter = makeIMessageAdapter(run, {
      platform: "darwin",
      homeDirectory: "/Users/test",
      nowIso: () => "2026-08-28T12:00:00.000Z",
    });

    const text = 'hello "quoted"; tell application "Finder"';
    const result = yield* adapter.sendMessage({
      accountId: IMESSAGE_ACCOUNT_ID,
      conversationId: ChannelConversationId.make("handle:+15555550123"),
      text,
      idempotencyKey: "send-1",
    });

    expect(invocation?.command).toBe("osascript");
    expect(invocation?.args.at(-1)).toBe(text);
    expect(invocation?.args.at(-2)).toBe("+15555550123");
    expect(result.message.sentAt).toBe("2026-08-28T12:00:00.000Z");
  }),
);
