// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

// DITTO: the Ditto cloud config rides the same root-env projection as T3 Connect.
describe("loadRepoEnv (Ditto cloud config)", () => {
  it("leaves the Ditto cloud config unset for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.VITE_DITTO_FIREBASE_API_KEY).toBeUndefined();
    expect(env.VITE_DITTO_FIREBASE_AUTH_DOMAIN).toBeUndefined();
    expect(env.VITE_DITTO_FIREBASE_PROJECT_ID).toBeUndefined();
    expect(env.VITE_DITTO_FIREBASE_APP_ID).toBeUndefined();
    expect(env.VITE_DITTO_API_BASE_URL).toBeUndefined();
  });

  it("projects DITTO_* root env into the VITE_DITTO_* bundle keys", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "DITTO_FIREBASE_API_KEY=key_root\nDITTO_FIREBASE_AUTH_DOMAIN=ditto.firebaseapp.com\nDITTO_FIREBASE_PROJECT_ID=ditto-project\nDITTO_FIREBASE_APP_ID=1:2:web:3\nDITTO_API_BASE_URL=https://staging-api-8.heyditto.ai\n",
    );

    const env = loadRepoEnv({ baseEnv: {}, repoRoot });

    expect(env.VITE_DITTO_FIREBASE_API_KEY).toBe("key_root");
    expect(env.VITE_DITTO_FIREBASE_AUTH_DOMAIN).toBe("ditto.firebaseapp.com");
    expect(env.VITE_DITTO_FIREBASE_PROJECT_ID).toBe("ditto-project");
    expect(env.VITE_DITTO_FIREBASE_APP_ID).toBe("1:2:web:3");
    expect(env.VITE_DITTO_API_BASE_URL).toBe("https://staging-api-8.heyditto.ai");
    expect(env.DITTO_API_BASE_URL).toBe("https://staging-api-8.heyditto.ai");
  });

  it("prefers the process env over root files for the Ditto cloud config", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "DITTO_API_BASE_URL=https://root.example.test\n",
    );

    const env = loadRepoEnv({
      baseEnv: { VITE_DITTO_API_BASE_URL: "https://process.example.test" },
      repoRoot,
    });

    expect(env.VITE_DITTO_API_BASE_URL).toBe("https://process.example.test");
  });
});
