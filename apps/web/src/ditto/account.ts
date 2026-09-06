/**
 * Ditto account commands against the thread's environment (the T3 server),
 * which owns the linked `ditto_mcp_` key. The renderer never stores the key:
 * the device-code flow hands it straight to the server through `link`.
 *
 * @module ditto/account
 */
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";
import { type DittoAccountLinkInput, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const dittoAccountCommands = {
  getStatus: createEnvironmentCommand(connectionAtomRuntime, {
    label: "ditto:account:get-status",
    execute: (_input: Record<never, never>) => request(WS_METHODS.dittoAccountGetStatus, {}),
  }),
  link: createEnvironmentCommand(connectionAtomRuntime, {
    label: "ditto:account:link",
    execute: (input: DittoAccountLinkInput) => request(WS_METHODS.dittoAccountLink, input),
  }),
  unlink: createEnvironmentCommand(connectionAtomRuntime, {
    label: "ditto:account:unlink",
    execute: (_input: Record<never, never>) => request(WS_METHODS.dittoAccountUnlink, {}),
  }),
};
