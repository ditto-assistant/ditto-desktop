/**
 * Sign in with Ditto.
 *
 * A Ditto account is the same Firebase identity ditto-app uses, so the desktop
 * initializes the Firebase web SDK against the Ditto project and reuses its
 * ID tokens for the Ditto API. Email + password works everywhere; Google
 * sign-in opens Firebase's popup handler, which the desktop shell allows as a
 * child window (see `apps/desktop/src/window/authPopup.ts`).
 *
 * The Firebase app is created lazily so an unconfigured clone never touches
 * the SDK, and it is a separate app instance from anything else so it can't
 * collide with T3's own cloud plumbing.
 *
 * @module ditto/firebase
 */
import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from "firebase/auth";

import { dittoFirebaseConfig } from "./config";

const DITTO_FIREBASE_APP_NAME = "ditto-cloud";

let cachedAuth: Auth | null = null;
let persistenceReady: Promise<void> | null = null;

function getDittoFirebaseApp(): FirebaseApp {
  if (dittoFirebaseConfig === null) {
    throw new Error("Ditto cloud is not configured for this build.");
  }
  const existing = getApps().find((app) => app.name === DITTO_FIREBASE_APP_NAME);
  return existing ?? initializeApp(dittoFirebaseConfig, DITTO_FIREBASE_APP_NAME);
}

/** The Ditto Firebase Auth instance; throws when the build is unconfigured. */
export function getDittoAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  const auth = getAuth(getDittoFirebaseApp());
  cachedAuth = auth;
  persistenceReady = setPersistence(auth, browserLocalPersistence).catch(() => {
    // Falls back to the SDK default (in-memory); sign-in still works for the session.
  });
  return auth;
}

async function ready(): Promise<Auth> {
  const auth = getDittoAuth();
  await persistenceReady;
  return auth;
}

export type DittoUser = User;

/** Subscribes to the signed-in Ditto user; the listener fires once on attach. */
export function subscribeDittoUser(listener: (user: DittoUser | null) => void): () => void {
  if (dittoFirebaseConfig === null) {
    listener(null);
    return () => {};
  }
  return onAuthStateChanged(getDittoAuth(), listener);
}

export async function signInWithDittoEmail(email: string, password: string): Promise<DittoUser> {
  const auth = await ready();
  const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  return credential.user;
}

export async function signInWithDittoGoogle(): Promise<DittoUser> {
  const auth = await ready();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  const credential = await signInWithPopup(auth, provider);
  return credential.user;
}

export async function signOutOfDitto(): Promise<void> {
  if (dittoFirebaseConfig === null) return;
  await firebaseSignOut(getDittoAuth());
}

/** Human-readable text for the Firebase Auth errors a sign-in form can hit. */
export function describeDittoSignInError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "That email and password don't match a Ditto account.";
    case "auth/invalid-email":
      return "That doesn't look like an email address.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a moment and try again.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google sign-in was closed before it finished.";
    case "auth/popup-blocked":
      return "The Google sign-in window was blocked. Use email and password instead.";
    case "auth/network-request-failed":
      return "Couldn't reach Ditto. Check your connection and try again.";
    default:
      return error instanceof Error && error.message ? error.message : "Sign-in failed. Try again.";
  }
}
