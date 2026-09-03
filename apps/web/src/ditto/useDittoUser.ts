/**
 * React binding for the signed-in Ditto user.
 *
 * One module-level store fed by Firebase's auth listener, read through
 * `useSyncExternalStore` so every consumer sees the same user without each
 * mounting its own listener.
 *
 * @module ditto/useDittoUser
 */
import { useSyncExternalStore } from "react";

import { isDittoCloudConfigured } from "./config";
import { subscribeDittoUser, type DittoUser } from "./firebase";

export interface DittoUserState {
  /** `false` until Firebase has reported the persisted session (or its absence). */
  readonly ready: boolean;
  readonly user: DittoUser | null;
}

const INITIAL_STATE: DittoUserState = { ready: false, user: null };
const UNCONFIGURED_STATE: DittoUserState = { ready: true, user: null };

let state: DittoUserState = isDittoCloudConfigured() ? INITIAL_STATE : UNCONFIGURED_STATE;
let unsubscribe: (() => void) | null = null;
const listeners = new Set<() => void>();

function ensureSubscribed() {
  if (unsubscribe !== null || !isDittoCloudConfigured()) return;
  unsubscribe = subscribeDittoUser((user) => {
    state = { ready: true, user };
    for (const listener of listeners) listener();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureSubscribed();
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DittoUserState {
  return state;
}

export function useDittoUser(): DittoUserState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The current user without subscribing; for imperative callers (fetch helpers). */
export function getCurrentDittoUser(): DittoUser | null {
  ensureSubscribed();
  return state.user;
}
