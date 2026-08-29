import {
  ChannelAccountId,
  ChannelOperationError,
  type ChannelConversation,
  type ChannelMessage,
  type ChannelSendMessageInput,
  type ChannelSendMessageResult,
  type ConnectedChannelAccount,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import { ServerConfig } from "../config.ts";
import { ProcessRunner, type ProcessRunInput } from "../processRunner.ts";
import type { ChannelAdapter, ChannelCommandRun } from "./ChannelAdapter.ts";
import { DISCORD_ACCOUNT_ID, makeDiscordCompositeAdapter } from "./DiscordCompositeAdapter.ts";
import { makeDiscordLocalAdapter } from "./DiscordLocalAdapter.ts";
import { DiscordSidecarClient } from "./DiscordSidecarClient.ts";
import { makeDiscrawlAdapter } from "./DiscrawlAdapter.ts";
import { DiscrawlManager } from "./DiscrawlManager.ts";
import { DiscordMediaCache } from "./DiscordMediaCache.ts";
import { IMESSAGE_ACCOUNT_ID, makeIMessageAdapter } from "./IMessageAdapter.ts";

export interface ChannelRegistryShape {
  readonly listAccounts: Effect.Effect<
    ReadonlyArray<ConnectedChannelAccount>,
    ChannelOperationError
  >;
  readonly listConversations: (
    accountId?: ChannelAccountId,
  ) => Effect.Effect<ReadonlyArray<ChannelConversation>, ChannelOperationError>;
  readonly configureAccount: (
    accountId: ChannelAccountId,
    enabled: boolean,
  ) => Effect.Effect<ConnectedChannelAccount, ChannelOperationError>;
  readonly listMessages: (
    accountId: ChannelAccountId,
    conversationId: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<ChannelMessage>, ChannelOperationError>;
  readonly sendMessage: (
    input: ChannelSendMessageInput,
  ) => Effect.Effect<ChannelSendMessageResult, ChannelOperationError>;
}

export class ChannelRegistry extends Context.Service<ChannelRegistry, ChannelRegistryShape>()(
  "t3/channels/ChannelRegistry",
) {}

function missingAccount(accountId: ChannelAccountId): ChannelOperationError {
  return new ChannelOperationError({
    accountId,
    kind: "account_not_found",
    message: `No local channel adapter is registered for ${accountId}.`,
  });
}

export function makeChannelRegistry(
  adapters: ReadonlyMap<ChannelAccountId, ChannelAdapter>,
): ChannelRegistryShape {
  const withAdapter = <A>(
    accountId: ChannelAccountId,
    use: (adapter: ChannelAdapter) => Effect.Effect<A, ChannelOperationError>,
  ): Effect.Effect<A, ChannelOperationError> => {
    const adapter = adapters.get(accountId);
    return adapter === undefined ? Effect.fail(missingAccount(accountId)) : use(adapter);
  };

  return {
    listAccounts: Effect.forEach(adapters.values(), (adapter) => adapter.discover, {
      concurrency: "unbounded",
    }).pipe(Effect.map((accounts) => [...accounts])),
    configureAccount: (accountId, enabled) =>
      withAdapter(accountId, (adapter) =>
        adapter.configure === undefined
          ? Effect.fail(
              new ChannelOperationError({
                accountId,
                kind: "capability_unavailable",
                message: "This local channel cannot be disabled.",
              }),
            )
          : adapter.configure(enabled),
      ),
    listConversations: (accountId) => {
      if (accountId !== undefined) {
        return withAdapter(accountId, (adapter) => adapter.listConversations);
      }
      return Effect.forEach(adapters.values(), (adapter) => adapter.listConversations, {
        concurrency: "unbounded",
      }).pipe(Effect.map((groups) => groups.flat()));
    },
    listMessages: (accountId, conversationId, limit) =>
      withAdapter(accountId, (adapter) => adapter.listMessages(conversationId, limit)),
    sendMessage: (input) => withAdapter(input.accountId, (adapter) => adapter.sendMessage(input)),
  };
}

export const layer = Layer.effect(
  ChannelRegistry,
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner;
    const platform = yield* HostProcessPlatform;
    const architecture = yield* HostProcessArchitecture;
    const environment = yield* HostProcessEnvironment;
    const config = yield* ServerConfig;
    const run: ChannelCommandRun = (input) => {
      const processInput: ProcessRunInput = {
        command: input.command,
        args: input.args,
        ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
      };
      return processRunner.run(processInput).pipe(
        Effect.map((output) => ({
          stdout: output.stdout,
          stderr: output.stderr,
          code: output.code,
        })),
        Effect.mapError(
          (cause) =>
            new ChannelOperationError({
              kind: "transport_failed",
              message: cause.message,
            }),
        ),
      );
    };
    const discrawl = new DiscrawlManager({
      baseDir: config.baseDir,
      stateDir: config.stateDir,
      homeDirectory: environment.HOME ?? "",
      platform,
      architecture,
      run,
    });
    const archive = makeDiscrawlAdapter(discrawl, {
      mediaCache: new DiscordMediaCache({ attachmentsDir: config.attachmentsDir }),
    });
    const sidecar = yield* Effect.acquireRelease(
      Effect.sync(() => new DiscordSidecarClient(config.discordSidecarPath, config.stateDir)),
      (client) => Effect.sync(() => client.close()),
    );
    const discord = makeDiscordCompositeAdapter({
      protocol: makeDiscordLocalAdapter(sidecar),
      archive,
    });
    return makeChannelRegistry(
      new Map([
        [DISCORD_ACCOUNT_ID, discord],
        [
          IMESSAGE_ACCOUNT_ID,
          makeIMessageAdapter(run, {
            platform,
            homeDirectory: environment.HOME ?? "",
          }),
        ],
      ]),
    );
  }),
);
