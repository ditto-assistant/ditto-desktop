/**
 * Teleport commands: stream a thread's capture through the environment and
 * mirror every progress frame into the dialog store; launch a Ditto Code cloud
 * session from a committed capsule.
 *
 * @module ditto/teleport
 */
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { request, runStream } from "@t3tools/client-runtime/rpc";
import {
  type TeleportCapsuleSummary,
  TeleportError,
  type TeleportLaunchCloudSessionInput,
  type TeleportThreadInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";
import { reportTeleportEvent } from "./teleportDialog";

export const teleportCommands = {
  thread: createEnvironmentCommand(connectionAtomRuntime, {
    label: "ditto:teleport:thread",
    execute: (input: TeleportThreadInput) =>
      runStream(WS_METHODS.teleportThread, input).pipe(
        Stream.tap((event) => Effect.sync(() => reportTeleportEvent(event))),
        Stream.runLast,
        Effect.flatMap(
          (last): Effect.Effect<TeleportCapsuleSummary, TeleportError> =>
            Option.isSome(last) && last.value.type === "complete"
              ? Effect.succeed(last.value.capsule)
              : Effect.fail(
                  new TeleportError({ message: "The teleport ended without a committed capsule." }),
                ),
        ),
      ),
  }),
  launchCloudSession: createEnvironmentCommand(connectionAtomRuntime, {
    label: "ditto:teleport:launch-cloud-session",
    execute: (input: TeleportLaunchCloudSessionInput) =>
      request(WS_METHODS.teleportLaunchCloudSession, input),
  }),
};
