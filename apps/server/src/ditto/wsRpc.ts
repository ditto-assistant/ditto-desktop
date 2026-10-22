/**
 * WebSocket RPC handlers for Ditto-only methods (memory harness, account link,
 * Teleport, chat channels). They are a separate group and layer from upstream's
 * handlers in `ws.ts`, which keeps that file close to upstream and keeps each
 * handler map small enough for the checker to infer.
 *
 * @module ditto/wsRpc
 */
import {
  DittoWsRpcGroup,
  type TeleportError,
  type TeleportProgressEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ChannelRegistry } from "../channels/ChannelRegistry.ts";
import { DittoHarnessService } from "../dittoHarness/DittoHarnessService.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { DittoAccountService } from "../teleport/DittoAccount.ts";
import { TeleportService } from "../teleport/TeleportService.ts";

export const DittoServerWsRpcGroup = DittoWsRpcGroup.middleware(RpcInstrumentation);

export const layerDittoWsRpc = DittoServerWsRpcGroup.toLayer(
  Effect.gen(function* () {
    const dittoHarness = yield* DittoHarnessService;
    const dittoAccount = yield* DittoAccountService;
    const teleport = yield* TeleportService;
    const channels = yield* ChannelRegistry;
    return DittoServerWsRpcGroup.of({
      [WS_METHODS.dittoHarnessStatus]: (_input) => dittoHarness.status,
      [WS_METHODS.dittoHarnessSaveMemory]: (input) => dittoHarness.saveMemory(input),
      [WS_METHODS.dittoHarnessSearchMemories]: (input) => dittoHarness.searchMemories(input),
      [WS_METHODS.dittoHarnessSearchSubjects]: (input) => dittoHarness.searchSubjects(input),
      [WS_METHODS.dittoHarnessDream]: (input) => dittoHarness.dream(input),
      [WS_METHODS.dittoAccountGetStatus]: (_input) => dittoAccount.status,
      [WS_METHODS.dittoAccountLink]: (input) => dittoAccount.link(input),
      [WS_METHODS.dittoAccountUnlink]: (_input) => dittoAccount.unlink,
      [WS_METHODS.dittoAccountStartDeviceLink]: (input) => dittoAccount.startDeviceLink(input),
      [WS_METHODS.dittoAccountPollDeviceLink]: (input) => dittoAccount.pollDeviceLink(input),
      [WS_METHODS.teleportThread]: (input) =>
        Stream.callback<TeleportProgressEvent, TeleportError>((queue) =>
          teleport
            .teleportThread(input, (progress) =>
              Queue.offer(queue, { type: "progress", ...progress }).pipe(Effect.asVoid),
            )
            .pipe(
              Effect.flatMap((capsule) =>
                Queue.offer(queue, { type: "complete", capsule }).pipe(Effect.asVoid),
              ),
              Effect.flatMap(() => Queue.end(queue)),
              Effect.catch((error) => Queue.fail(queue, error)),
            ),
        ),
      [WS_METHODS.teleportLaunchCloudSession]: (input) => teleport.launchCloudSession(input),
      [WS_METHODS.channelsListAccounts]: (_input) =>
        channels.listAccounts.pipe(Effect.map((accounts) => ({ accounts }))),
      [WS_METHODS.channelsConfigureAccount]: (input) =>
        channels
          .configureAccount(input.accountId, input.enabled)
          .pipe(Effect.map((account) => ({ account }))),
      [WS_METHODS.channelsListConversations]: (input) =>
        channels
          .listConversations(input.accountId)
          .pipe(Effect.map((conversations) => ({ conversations }))),
      [WS_METHODS.channelsListMessages]: (input) =>
        channels
          .listMessages(input.accountId, input.conversationId, input.limit)
          .pipe(Effect.map((messages) => ({ messages }))),
      [WS_METHODS.channelsSendMessage]: (input) => channels.sendMessage(input),
    });
  }),
);
