/**
 * Ditto account commands against the thread's environment (the T3 server),
 * which owns the linked `ditto_mcp_` key. The renderer never stores the key:
 * the device-code flow hands it straight to the server through `link`.
 *
 * @module ditto/account
 */
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";
import {
  type DittoAccountLinkInput,
  type DittoDeviceLinkPollInput,
  type DittoDeviceLinkStartInput,
  WS_METHODS,
} from "@t3tools/contracts";

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
  /** Server-driven device-code flow: the server talks to Ditto, the renderer shows state. */
  startDeviceLink: createEnvironmentCommand(connectionAtomRuntime, {
    label: "ditto:account:start-device-link",
    execute: (input: DittoDeviceLinkStartInput) =>
      request(WS_METHODS.dittoAccountStartDeviceLink, input),
  }),
  pollDeviceLink: createEnvironmentCommand(connectionAtomRuntime, {
    label: "ditto:account:poll-device-link",
    execute: (input: DittoDeviceLinkPollInput) =>
      request(WS_METHODS.dittoAccountPollDeviceLink, input),
  }),
};
