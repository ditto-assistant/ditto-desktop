import { describe, expect, it } from "vite-plus/test";

import {
  INITIAL_PAIRING_STATE,
  initialPairingCredentials,
  isPairingWait,
  pollPairingCredentials,
  reducePairing,
  type PairingState,
} from "./googleMessagesPairing.logic";

const emoji = { field: "poll", kind: "emoji", prompt: "🐱", state: "enc-1" };

describe("reducePairing", () => {
  it("walks the happy path from sign-in to connected", () => {
    let state: PairingState = INITIAL_PAIRING_STATE;
    state = reducePairing(state, { type: "start" });
    expect(state.phase).toBe("signing-in");
    state = reducePairing(state, { type: "cookies-ready" });
    expect(state.phase).toBe("connecting");
    state = reducePairing(state, { type: "challenge", challenge: emoji });
    expect(state).toEqual({ phase: "waiting", challenge: emoji });
    state = reducePairing(state, { type: "connected" });
    expect(state.phase).toBe("connected");
  });

  it("explains a closed or timed-out sign-in window only while signing in", () => {
    const closed = reducePairing(
      { phase: "signing-in" },
      { type: "sign-in-cancelled", reason: "closed" },
    );
    expect(closed).toEqual({
      phase: "failed",
      message: "The Google sign-in window was closed before it finished.",
    });
    const timeout = reducePairing(
      { phase: "signing-in" },
      { type: "sign-in-cancelled", reason: "timeout" },
    );
    expect(timeout.phase).toBe("failed");
    // A stale cancellation after the flow moved on is ignored.
    expect(
      reducePairing({ phase: "connecting" }, { type: "sign-in-cancelled", reason: "closed" }),
    ).toEqual({
      phase: "connecting",
    });
  });

  it("keeps the newest challenge and resets to idle", () => {
    const rotated = { ...emoji, state: "enc-2" };
    const waiting = reducePairing(
      { phase: "waiting", challenge: emoji },
      { type: "challenge", challenge: rotated },
    );
    expect(waiting).toEqual({ phase: "waiting", challenge: rotated });
    expect(reducePairing(waiting, { type: "error", message: "rejected" })).toEqual({
      phase: "failed",
      message: "rejected",
    });
    expect(reducePairing(waiting, { type: "reset" })).toEqual(INITIAL_PAIRING_STATE);
  });
});

describe("credentials", () => {
  it("starts pairing with the cookies as a JSON object string", () => {
    expect(initialPairingCredentials({ SID: "a", OSID: "b" })).toEqual({
      method: "google",
      cookies: '{"SID":"a","OSID":"b"}',
    });
  });

  it("polls by echoing the challenge field and encrypted state", () => {
    expect(pollPairingCredentials(emoji)).toEqual({ poll: "1", _state: "enc-1" });
  });

  it("recognizes device-pairing waits", () => {
    expect(isPairingWait(emoji)).toBe(true);
    expect(isPairingWait({ field: "code", kind: "code", prompt: "Enter code", state: "x" })).toBe(
      false,
    );
  });
});
