/**
 * Pure decisions for the Ditto Account settings page, kept out of React so the
 * "what renders when" table is unit-testable without the environment atoms
 * the device-link row needs.
 *
 * @module DittoAccountSettings.logic
 */

export interface DittoAccountRows {
  /** Firebase sign-in / signed-in account row. Needs the public Firebase config. */
  readonly signIn: boolean;
  /** The notice explaining that Firebase sign-in is unavailable in this build. */
  readonly unconfiguredNotice: boolean;
  /** Which Ditto backend this computer talks to. Never gated. */
  readonly backend: boolean;
  /** Device-code "Link this computer". Needs only the API base URL. */
  readonly deviceLink: boolean;
  /** Cloud connections (Google Messages) need a signed-in Firebase user. */
  readonly connections: boolean;
}

/**
 * Sign-in with Ditto needs Firebase; linking the computer does not. A build
 * without `DITTO_FIREBASE_*` therefore still offers the backend picker and the
 * device-code link so Teleport and Ditto Code work.
 */
export function resolveDittoAccountRows(firebaseConfigured: boolean): DittoAccountRows {
  return {
    signIn: firebaseConfigured,
    unconfiguredNotice: !firebaseConfigured,
    backend: true,
    deviceLink: true,
    connections: firebaseConfigured,
  };
}

/**
 * One-line console notice when a per-machine backend override is active, so a
 * tester pointed at a preview slot can tell at a glance which API the desktop
 * is really using. `null` when the default applies.
 */
export function describeApiBaseOverride(input: {
  readonly stored: string | null;
  readonly resolved: string;
  readonly production: string;
}): string | null {
  if (input.stored === null || input.resolved === input.production) return null;
  return `Ditto backend override active: ${input.resolved} (localStorage "ditto.apiBaseUrl"). Remove the key or pick Production in Settings → Ditto Account to reset.`;
}
