/// <reference types="vite-plus/client" />

import type { DesktopBridge } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_CLERK_JWT_TEMPLATE: string;
  readonly VITE_CLERK_CLI_OAUTH_CLIENT_ID: string;
  readonly VITE_RELAY_OTLP_TRACES_URL: string;
  readonly VITE_RELAY_OTLP_TRACES_DATASET: string;
  readonly VITE_RELAY_OTLP_TRACES_TOKEN: string;
  readonly APP_VERSION: string;
  // DITTO: Ditto cloud account config (see .env.example).
  readonly VITE_DITTO_FIREBASE_API_KEY?: string;
  readonly VITE_DITTO_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_DITTO_FIREBASE_PROJECT_ID?: string;
  readonly VITE_DITTO_FIREBASE_APP_ID?: string;
  readonly VITE_DITTO_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}
