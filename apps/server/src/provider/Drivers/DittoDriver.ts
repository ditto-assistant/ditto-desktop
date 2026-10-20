import { DittoSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { ServerConfig } from "../../config.ts";
import { makeDittoHarnessOpener } from "../../dittoHarness/DittoHarnessRuntime.ts";
import { makeDittoTextGeneration } from "../../textGeneration/DittoTextGeneration.ts";
import { makeDittoAdapter } from "../DittoAdapter.ts";
import { checkDittoProviderStatus, makePendingDittoProvider } from "../DittoProvider.ts";

const decodeDittoSettings = Schema.decodeSync(DittoSettings);
const DRIVER_KIND = ProviderDriverKind.make("ditto");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(2);

export type DittoDriverEnv = ProviderHost.ProviderHost | Path.Path | ServerConfig;

// DITTO: the local Ditto harness as a built-in provider driver. Upstream moved
// drivers onto provider-core and orchestration-v2 adapters; this follows that
// shape (see packages/provider-grok/src/server/driver.ts).
export const DittoDriver: ProviderDriver<DittoSettings, DittoDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Ditto",
    supportsMultipleInstances: true,
  },
  configSchema: DittoSettings,
  defaultConfig: (): DittoSettings => decodeDittoSettings({}),
  create: Effect.fn("DittoDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    enabled,
    config,
  }) {
    const serverConfig = yield* ServerConfig;
    const path = yield* Path.Path;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies DittoSettings;
    const opener = makeDittoHarnessOpener({
      config: serverConfig,
      path,
    });

    const orchestrationAdapter = yield* makeDittoAdapter(effectiveConfig, {
      instanceId,
      opener,
    });
    const textGeneration = yield* makeDittoTextGeneration(effectiveConfig, opener);
    const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
    });

    const snapshot = yield* makeManagedServerProvider<DittoSettings>({
      resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
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
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
