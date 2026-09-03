/**
 * The Google Messages pairing flow as a pure state machine.
 *
 * The desktop drives it: sign in to Google in the isolated window, post the
 * cookies to the Ditto backend, show the pairing emoji the backend returns,
 * then poll (echoing the encrypted `_state`) until the phone confirms. Kept
 * free of React and network so the transitions are unit-testable.
 *
 * @module ditto/googleMessagesPairing.logic
 */

export interface PairingChallenge {
  readonly field: string;
  readonly kind: string;
  readonly prompt: string;
  readonly state: string;
}

export type PairingState =
  | { readonly phase: "idle" }
  | { readonly phase: "signing-in" }
  | { readonly phase: "connecting" }
  | { readonly phase: "waiting"; readonly challenge: PairingChallenge }
  | { readonly phase: "connected" }
  | { readonly phase: "failed"; readonly message: string };

export type PairingEvent =
  | { readonly type: "start" }
  | { readonly type: "sign-in-cancelled"; readonly reason: string }
  | { readonly type: "cookies-ready" }
  | { readonly type: "challenge"; readonly challenge: PairingChallenge }
  | { readonly type: "connected" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "reset" };

export const INITIAL_PAIRING_STATE: PairingState = { phase: "idle" };

/** How often to ask the backend whether the phone has confirmed. */
export const PAIRING_POLL_INTERVAL_MS = 2500;

export function reducePairing(state: PairingState, event: PairingEvent): PairingState {
  switch (event.type) {
    case "start":
      return { phase: "signing-in" };
    case "sign-in-cancelled":
      return state.phase === "signing-in"
        ? { phase: "failed", message: describeCancellation(event.reason) }
        : state;
    case "cookies-ready":
      return { phase: "connecting" };
    case "challenge":
      return { phase: "waiting", challenge: event.challenge };
    case "connected":
      return { phase: "connected" };
    case "error":
      return { phase: "failed", message: event.message };
    case "reset":
      return INITIAL_PAIRING_STATE;
  }
}

function describeCancellation(reason: string): string {
  switch (reason) {
    case "timeout":
      return "The Google sign-in window timed out. Start again when you're ready.";
    case "superseded":
      return "A newer sign-in replaced this one.";
    default:
      return "The Google sign-in window was closed before it finished.";
  }
}

/** The credentials that start Google Account pairing from harvested cookies. */
export function initialPairingCredentials(
  cookies: Readonly<Record<string, string>>,
): Record<string, string> {
  return { method: "google", cookies: JSON.stringify(cookies) };
}

/** The credentials that poll a pairing wait: echo "1" under the challenge field plus the encrypted state. */
export function pollPairingCredentials(challenge: PairingChallenge): Record<string, string> {
  return { [challenge.field]: "1", _state: challenge.state };
}

/** A device-pairing wait the desktop should poll, as opposed to a typed challenge. */
export function isPairingWait(challenge: PairingChallenge): boolean {
  return challenge.field === "poll" && (challenge.kind === "emoji" || challenge.kind === "qr");
}
