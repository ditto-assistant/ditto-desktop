import {
  DEFAULT_DITTO_CHAT_MODEL,
  type DittoSettings,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  type DittoHarnessModelOptions,
  type DittoHarnessOpener,
  dittoHarnessError,
  explainDittoHarnessFailure,
  trimToUndefined,
  toDittoHarnessMessage,
} from "../../dittoHarness/DittoHarnessRuntime.ts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("ditto");

const DITTO_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [],
});

const DITTO_PRESENTATION = {
  displayName: "Ditto",
  badgeLabel: "Local",
  showInteractionModeToggle: false,
} as const;

function providerLabel(settings: Pick<DittoSettings, "chatProvider">): string {
  switch (settings.chatProvider) {
    case "ollama":
      return "Ollama";
    case "openrouter":
      return "OpenRouter";
    case "vllm":
      return "vLLM";
  }
}

function baseModels(settings: DittoSettings): ReadonlyArray<ServerProviderModel> {
  const model = trimToUndefined(settings.chatModel) ?? DEFAULT_DITTO_CHAT_MODEL;
  const defaults: ServerProviderModel[] = [
    {
      slug: model,
      name: model,
      shortName: model,
      subProvider: providerLabel(settings),
      isCustom: false,
      capabilities: DITTO_MODEL_CAPABILITIES,
    },
  ];

  if (model !== DEFAULT_DITTO_CHAT_MODEL) {
    defaults.push({
      slug: DEFAULT_DITTO_CHAT_MODEL,
      name: DEFAULT_DITTO_CHAT_MODEL,
      shortName: DEFAULT_DITTO_CHAT_MODEL,
      subProvider: "Ollama",
      isCustom: false,
      capabilities: DITTO_MODEL_CAPABILITIES,
    });
  }

  return defaults;
}

function modelsForSettings(settings: DittoSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    baseModels(settings),
    settings.customModels,
    DITTO_MODEL_CAPABILITIES,
  );
}

function localAuthLabel(settings: DittoSettings): string {
  return settings.chatProvider === "openrouter" ? "OpenRouter" : `Local ${providerLabel(settings)}`;
}

function modelOptions(settings: DittoSettings): DittoHarnessModelOptions {
  const model = trimToUndefined(settings.chatModel);
  const baseUrl = trimToUndefined(settings.chatBaseUrl);
  return {
    provider: settings.chatProvider,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    saveMemory: false,
    maxTurns: 1,
  };
}

export function makePendingDittoProvider(
  settings: DittoSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      driver: PROVIDER,
      presentation: DITTO_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: modelsForSettings(settings),
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: {
          status: "authenticated",
          type: "local",
          label: localAuthLabel(settings),
        },
        message: "Checking local Ditto Harness.",
      },
    }),
  );
}

export function checkDittoProviderStatus(
  settings: DittoSettings,
  opener: DittoHarnessOpener,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) {
      return buildServerProvider({
        driver: PROVIDER,
        presentation: DITTO_PRESENTATION,
        enabled: false,
        checkedAt,
        models: modelsForSettings(settings),
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: {
            status: "unknown",
            type: "local",
          },
          message: "Ditto provider is disabled.",
        },
      });
    }

    const opened = yield* Effect.result(opener(settings));
    if (opened._tag === "Failure") {
      const message = opened.failure.message;
      const nativeMissing = message.includes("native binding is unavailable");
      return buildServerProvider({
        driver: PROVIDER,
        presentation: DITTO_PRESENTATION,
        enabled: true,
        checkedAt,
        models: modelsForSettings(settings),
        probe: {
          installed: !nativeMissing,
          version: null,
          status: "error",
          auth: {
            status: "unknown",
            type: "local",
          },
          message,
        },
      });
    }

    const chatProbe = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          opened.success.harness.chat(opened.success.settings.userId, "Reply with: ok", {
            ...modelOptions(settings),
            sessionId: "__t3_ditto_provider_probe__",
          }),
        catch: (cause) =>
          dittoHarnessError(
            "operation_failed",
            explainDittoHarnessFailure(
              `Ditto provider probe failed: ${toDittoHarnessMessage(cause)}`,
            ),
            cause,
          ),
      }),
    );

    if (chatProbe._tag === "Failure") {
      return buildServerProvider({
        driver: PROVIDER,
        presentation: DITTO_PRESENTATION,
        enabled: true,
        checkedAt,
        models: modelsForSettings(settings),
        probe: {
          installed: true,
          version: opened.success.version ?? null,
          status: "error",
          auth: {
            status: "unknown",
            type: "local",
          },
          message: chatProbe.failure.message,
        },
      });
    }

    return buildServerProvider({
      driver: PROVIDER,
      presentation: DITTO_PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelsForSettings(settings),
      probe: {
        installed: true,
        version: opened.success.version ?? null,
        status: "ready",
        auth: {
          status: "authenticated",
          type: "local",
          label: localAuthLabel(settings),
        },
      },
    });
  });
}
