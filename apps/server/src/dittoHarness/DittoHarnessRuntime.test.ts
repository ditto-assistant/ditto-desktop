import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { DittoHarnessService, DittoHarnessServiceLive } from "./DittoHarnessService.ts";
import { dittoActionModelOptions } from "./DittoHarnessRuntime.ts";

describe("DittoHarnessRuntime", () => {
  it("uses action model settings when configured", () => {
    assert.deepEqual(
      dittoActionModelOptions({
        chatProvider: "ollama",
        chatModel: "qwen3:4b",
        chatBaseUrl: "http://127.0.0.1:11434",
        actionProvider: "openrouter",
        actionModel: "google/gemini-3.5-flash",
        actionBaseUrl: "",
      }),
      {
        provider: "openrouter",
        model: "google/gemini-3.5-flash",
      },
    );
  });

  it("keeps the chat base URL only when the action provider is not overridden", () => {
    assert.deepEqual(
      dittoActionModelOptions({
        chatProvider: "ollama",
        chatModel: "qwen3:4b",
        chatBaseUrl: "http://127.0.0.1:11434",
        actionProvider: "ollama",
        actionModel: "qwen3-coder:latest",
        actionBaseUrl: "",
      }),
      {
        provider: "ollama",
        model: "qwen3-coder:latest",
        baseUrl: "http://127.0.0.1:11434",
      },
    );
  });

  it("falls back to chat model settings when action settings are absent", () => {
    assert.deepEqual(
      dittoActionModelOptions({
        chatProvider: "vllm",
        chatModel: "local-tool-model",
        chatBaseUrl: "http://localhost:8000/v1",
      }),
      {
        provider: "vllm",
        model: "local-tool-model",
        baseUrl: "http://localhost:8000/v1",
      },
    );
  });
});

describe("DittoHarnessService", () => {
  const supportLayer = Layer.mergeAll(
    ServerSettingsService.layerTest({
      dittoHarness: {
        ...DEFAULT_SERVER_SETTINGS.dittoHarness,
        enabled: true,
        enablePromptContext: true,
        embedder: "hash",
      },
    }),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-ditto-harness-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    NodeServices.layer,
  );
  const layer = Layer.mergeAll(
    DittoHarnessServiceLive.pipe(Layer.provide(supportLayer)),
    supportLayer,
  );

  it.effect("fails open when prompt context cannot open the native harness", () =>
    Effect.gen(function* () {
      const previousNodePath = process.env.DITTO_HARNESS_NODE_PATH;
      process.env.DITTO_HARNESS_NODE_PATH = "/tmp/t3-missing-ditto-harness-node";

      const result = yield* Effect.gen(function* () {
        const service = yield* DittoHarnessService;
        return yield* service.buildPromptContext({
          userInput: "what should I remember about this project?",
          sessionId: "thread-1",
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previousNodePath === undefined) {
              delete process.env.DITTO_HARNESS_NODE_PATH;
            } else {
              process.env.DITTO_HARNESS_NODE_PATH = previousNodePath;
            }
          }),
        ),
      );

      assert.equal(result, null);
    }).pipe(Effect.provide(layer)),
  );
});
