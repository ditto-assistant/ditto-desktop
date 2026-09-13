/**
 * Which threads can be teleported. Teleport needs a coding harness whose
 * session the Ditto Code cloud runner can resume, and the contract's
 * provider → harness table is the single source of truth for that. The thread
 * shell's `session.providerName` carries the provider driver kind
 * (`claudeAgent`, `codex`, `cursor`, …), never an instance id, so custom
 * instances of a supported CLI qualify too.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { teleportHarnessForProvider } from "@t3tools/contracts";

export function threadSupportsTeleport(thread: Pick<EnvironmentThreadShell, "session">): boolean {
  return teleportHarnessForProvider(thread.session?.providerName) !== null;
}
