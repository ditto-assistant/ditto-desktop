import { DittoSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeDittoHarnessOpener } from "../../dittoHarness/DittoHarnessRuntime.ts";
import { makeDittoTextGeneration } from "../../textGeneration/DittoTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDittoAdapter } from "../Layers/DittoAdapter.ts";
import { checkDittoProviderStatus, makePendingDittoProvider } from "../Layers/DittoProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const decodeDittoSettings = Schema.decodeSync(DittoSettings);
const DRIVER_KIND = ProviderDriverKind.make("ditto");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(2);

export type DittoDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const DittoDriver: ProviderDriver<DittoSettings, DittoDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Ditto",
    supportsMultipleInstances: true,
  },
  configSchema: DittoSettings,
  defaultConfig: (): DittoSettings => decodeDittoSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const path = yield* Path.Path;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies DittoSettings;
      const opener = makeDittoHarnessOpener({
        config: serverConfig,
        path,
      });

      const adapter = yield* makeDittoAdapter(effectiveConfig, {
        instanceId,
        opener,
      });
      const textGeneration = yield* makeDittoTextGeneration(effectiveConfig, opener);
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });

      const snapshot = yield* makeManagedServerProvider<DittoSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingDittoProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider: checkDittoProviderStatus(effectiveConfig, opener).pipe(
          Effect.map(stampIdentity),
        ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Ditto snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
