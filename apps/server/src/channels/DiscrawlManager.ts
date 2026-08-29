// @effect-diagnostics nodeBuiltinImport:off -- Managed tool installation is a Node host boundary.
// @effect-diagnostics preferSchemaOverJson:off -- The persisted state is one private boolean.
// @effect-diagnostics globalFetchInEffect:off -- Download failures are captured by Effect.tryPromise.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { ChannelAccountId, ChannelOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ChannelCommandOutput, ChannelCommandRun } from "./ChannelAdapter.ts";
const DISCRAWL_ACCOUNT_ID = ChannelAccountId.make("discord:discrawl:local");

const DISCRAWL_VERSION = "0.13.3";

const releaseAssets = {
  "darwin-arm64": {
    archive: `discrawl_${DISCRAWL_VERSION}_darwin_arm64.tar.gz`,
    sha256: "664028f5f3489fe70186fdc1d99d2956df69ea754d4a1f14acc4057c04c165a1",
  },
  "darwin-x64": {
    archive: `discrawl_${DISCRAWL_VERSION}_darwin_amd64.tar.gz`,
    sha256: "da2c0e68fd2df4bf07c7e496be9984ed2ff651faa966e2a94fe421517c90bf94",
  },
  "linux-arm64": {
    archive: `discrawl_${DISCRAWL_VERSION}_linux_arm64.tar.gz`,
    sha256: "5985937f6b31b95ec4bd06b9e81d9d5dbda21707273b5016a6be89783418647f",
  },
  "linux-x64": {
    archive: `discrawl_${DISCRAWL_VERSION}_linux_amd64.tar.gz`,
    sha256: "d9ba53c3137b0247d221519708bc70f23c64f74b2512665b27ab0c3e714642c1",
  },
} as const;

type SupportedTarget = keyof typeof releaseAssets;

interface DiscrawlState {
  readonly enabled: boolean;
}

export interface DiscrawlManagerOptions {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly run: ChannelCommandRun;
}

function operationError(kind: "setup_required" | "transport_failed", message: string) {
  return new ChannelOperationError({
    accountId: DISCRAWL_ACCOUNT_ID,
    kind,
    message,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

export class DiscrawlManager {
  readonly #options: DiscrawlManagerOptions;
  readonly #statePath: string;
  readonly #installDir: string;
  readonly #binaryPath: string;

  constructor(options: DiscrawlManagerOptions) {
    this.#options = options;
    const target = `${options.platform}-${options.architecture}`;
    this.#statePath = NodePath.join(options.stateDir, "channels", "discord.json");
    this.#installDir = NodePath.join(
      options.baseDir,
      "tools",
      "discrawl",
      `v${DISCRAWL_VERSION}`,
      target,
    );
    this.#binaryPath = NodePath.join(this.#installDir, "discrawl");
  }

  isEnabled(): Effect.Effect<boolean> {
    return Effect.promise(async () => {
      try {
        const value = JSON.parse(await NodeFSP.readFile(this.#statePath, "utf8")) as DiscrawlState;
        return value.enabled === true;
      } catch {
        return false;
      }
    });
  }

  isDiscordInstalled(): Effect.Effect<boolean> {
    const { homeDirectory, platform } = this.#options;
    return Effect.promise(async () => {
      if (platform === "darwin") {
        return (
          (await pathExists("/Applications/Discord.app")) ||
          (await pathExists(NodePath.join(homeDirectory, "Applications", "Discord.app"))) ||
          (await pathExists(NodePath.join(homeDirectory, "Library/Application Support/discord")))
        );
      }
      if (platform === "linux") {
        return (
          (await pathExists(NodePath.join(homeDirectory, ".config/discord"))) ||
          (await pathExists("/usr/bin/discord"))
        );
      }
      return false;
    });
  }

  configure(enabled: boolean): Effect.Effect<void, ChannelOperationError> {
    const statePath = this.#statePath;
    const installed = this.isDiscordInstalled();
    const ensureInstalled = this.ensureInstalled();
    const wiretap = this.execute(["--json", "wiretap"], "2 minutes").pipe(Effect.asVoid);
    return Effect.gen(function* () {
      if (enabled) {
        if (!(yield* installed)) {
          return yield* Effect.fail(
            operationError("setup_required", "Install and sign in to Discord Desktop first."),
          );
        }
        yield* ensureInstalled;
        yield* wiretap;
      }
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(NodePath.dirname(statePath), { recursive: true });
          await NodeFSP.writeFile(statePath, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
        },
        catch: (cause) =>
          operationError(
            "transport_failed",
            `Could not save Discord sync setting: ${String(cause)}`,
          ),
      });
    });
  }

  execute(
    args: ReadonlyArray<string>,
    timeout: "30 seconds" | "2 minutes" = "30 seconds",
  ): Effect.Effect<ChannelCommandOutput, ChannelOperationError> {
    return this.resolveBinary().pipe(
      Effect.flatMap((command) => this.#options.run({ command, args, timeout })),
    );
  }

  resolveBinary(): Effect.Effect<string, ChannelOperationError> {
    const override = process.env.T3CODE_DISCRAWL_PATH?.trim();
    if (override) return Effect.succeed(override);
    return Effect.promise(() => pathExists(this.#binaryPath)).pipe(
      Effect.flatMap((installed) =>
        installed
          ? Effect.succeed(this.#binaryPath)
          : Effect.fail(
              operationError(
                "setup_required",
                "Turn on Discord sync to install the managed Discrawl helper.",
              ),
            ),
      ),
    );
  }

  ensureInstalled(): Effect.Effect<string, ChannelOperationError> {
    const binaryPath = this.#binaryPath;
    const installDir = this.#installDir;
    const options = this.#options;
    return Effect.gen(function* () {
      if (yield* Effect.promise(() => pathExists(binaryPath))) return binaryPath;

      const target = `${options.platform}-${options.architecture}` as SupportedTarget;
      const asset = releaseAssets[target];
      if (asset === undefined) {
        return yield* Effect.fail(
          operationError(
            "setup_required",
            `Managed Discrawl is not available for ${options.platform}/${options.architecture}.`,
          ),
        );
      }

      const downloadUrl = `https://github.com/openclaw/discrawl/releases/download/v${DISCRAWL_VERSION}/${asset.archive}`;
      const stagingDir = `${installDir}.tmp-${NodeCrypto.randomUUID()}`;
      const archivePath = NodePath.join(stagingDir, asset.archive);
      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(stagingDir, { recursive: true });
          const response = await fetch(downloadUrl, { redirect: "follow" });
          if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
          if (digest !== asset.sha256) throw new Error("download checksum did not match");
          await NodeFSP.writeFile(archivePath, bytes);
        },
        catch: (cause) =>
          operationError("transport_failed", `Could not download Discrawl: ${String(cause)}`),
      });

      const extracted = yield* options.run({
        command: "/usr/bin/tar",
        args: ["-xzf", archivePath, "-C", stagingDir],
        timeout: "30 seconds",
      });
      if (extracted.code !== 0) {
        return yield* Effect.fail(
          operationError(
            "transport_failed",
            extracted.stderr.trim() || "Could not unpack Discrawl.",
          ),
        );
      }

      const stagedBinary = NodePath.join(stagingDir, "discrawl");
      yield* Effect.tryPromise({
        try: () => NodeFSP.chmod(stagedBinary, 0o755),
        catch: (cause) =>
          operationError("transport_failed", `Could not prepare Discrawl: ${String(cause)}`),
      });
      const validation = yield* options.run({
        command: stagedBinary,
        args: ["--version"],
        timeout: "30 seconds",
      });
      if (validation.code !== 0 || !validation.stdout.includes(DISCRAWL_VERSION)) {
        return yield* Effect.fail(
          operationError("transport_failed", "The downloaded Discrawl helper failed validation."),
        );
      }

      yield* Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(NodePath.dirname(installDir), { recursive: true });
          await NodeFSP.rm(installDir, { recursive: true, force: true });
          await NodeFSP.rename(stagingDir, installDir);
        },
        catch: (cause) =>
          operationError("transport_failed", `Could not activate Discrawl: ${String(cause)}`),
      });
      return binaryPath;
    });
  }
}
