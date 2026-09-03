/**
 * Ditto cloud configuration for the desktop/web renderer.
 *
 * The Ditto account features (sign in with Ditto, Google Messages pairing)
 * are optional: a clone without the public Firebase identifiers in its root
 * `.env` builds and runs with the Ditto Account settings section explaining
 * what is missing instead of failing at startup.
 *
 * @module ditto/config
 */

export interface DittoFirebaseConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly appId: string;
}

function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

/**
 * The public Firebase web config, or `null` when any identifier is missing.
 * All four are needed: the API key and app id for the Auth REST calls, the
 * auth domain for the sign-in popup handler, the project id for token
 * issuance.
 */
export function resolveDittoFirebaseConfig(
  env: Readonly<Record<string, string | undefined>> = import.meta.env,
): DittoFirebaseConfig | null {
  const apiKey = trimNonEmpty(env.VITE_DITTO_FIREBASE_API_KEY);
  const authDomain = trimNonEmpty(env.VITE_DITTO_FIREBASE_AUTH_DOMAIN);
  const projectId = trimNonEmpty(env.VITE_DITTO_FIREBASE_PROJECT_ID);
  const appId = trimNonEmpty(env.VITE_DITTO_FIREBASE_APP_ID);
  if (!apiKey || !authDomain || !projectId || !appId) {
    return null;
  }
  return { apiKey, authDomain, projectId, appId };
}

export const dittoFirebaseConfig: DittoFirebaseConfig | null = resolveDittoFirebaseConfig();

export function isDittoCloudConfigured(): boolean {
  return dittoFirebaseConfig !== null;
}
