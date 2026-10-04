// DITTO: OmniSynth integration.
import {
  EnvironmentId,
  OmniSynthUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OmniSynthService from "../../../omnisynth/OmniSynthService.ts";
import { omniSynthQuickStart, OmniSynthToolkitHandlersLive } from "./handlers.ts";
import { OmniSynthToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-omnisynth");

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const runningStatus = {
  installed: true,
  running: true,
  version: "0.2.0",
  appPath: "/Applications/OmniSynth.app",
  song: { bpm: 128 },
  tools: [{ name: "add_track", description: "Add a step-sequenced track." }],
};

interface HarnessOptions {
  readonly service?: Partial<OmniSynthService.OmniSynthServiceShape>;
  readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
}

const makeHarness = Effect.fn("makeOmniSynthToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const calls: Array<{ readonly name: string; readonly args: unknown }> = [];
  const generations: Array<{
    readonly prompt: string;
    readonly mode: string;
    readonly source: string;
  }> = [];
  const service: OmniSynthService.OmniSynthServiceShape = {
    status: () => Effect.succeed(runningStatus),
    state: Effect.succeed({ bpm: 128, tracks: [] }),
    callTool: (name, args) => {
      calls.push({ name, args });
      return Effect.succeed(`${name} ok`);
    },
    generate: (input) => {
      generations.push({ prompt: input.prompt, mode: input.mode, source: input.source });
      return Effect.succeed({ summary: "Built a loop.", state: { bpm: 128 } });
    },
    launch: () => Effect.succeed(runningStatus),
    ...options.service,
  };
  const ServiceLayer = Layer.succeed(
    OmniSynthService.OmniSynthService,
    OmniSynthService.OmniSynthService.of(service),
  );
  const toolkit = yield* OmniSynthToolkit.pipe(
    Effect.provide(OmniSynthToolkitHandlersLive.pipe(Layer.provide(ServiceLayer))),
  );
  const call = <Name extends keyof typeof OmniSynthToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof OmniSynthToolkit.tools)[Name]>,
      ),
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation(options.capabilities ?? ["omnisynth"]),
      ),
      Effect.provide(ServiceLayer),
    );
  return { call, calls, generations };
});

describe("OmniSynth toolkit", () => {
  it.effect("status includes the catalog and quick start", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("omnisynth_status", {});
      expect(result.running).toBe(true);
      expect(result.tools).toEqual(runningStatus.tools);
      expect(result.quickStart).toContain("omnisynth_generate");
    }),
  );

  it.effect("generate tags the job with the calling thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("omnisynth_generate", { prompt: "acid techno" });
      expect(result.summary).toBe("Built a loop.");
      expect(harness.generations).toEqual([
        { prompt: "acid techno", mode: "iterate", source: `ditto-desktop:${THREAD_ID}` },
      ]);
    }),
  );

  it.effect("tool proxies to the DAW by name", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("omnisynth_tool", {
        name: "set_bpm",
        arguments: { bpm: 140 },
      });
      expect(result).toEqual({ result: "set_bpm ok" });
      expect(harness.calls).toEqual([{ name: "set_bpm", args: { bpm: 140 } }]);
    }),
  );

  it.effect("refuses without the omnisynth capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ capabilities: ["preview"] });
      const error = yield* harness.call("omnisynth_state", {}).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OmniSynthUnavailableError);
      expect(harness.calls).toEqual([]);
    }),
  );

  it("quick start explains each availability state", () => {
    expect(omniSynthQuickStart(false, false)).toContain("not installed");
    expect(omniSynthQuickStart(false, true)).toContain("omnisynth_launch");
    expect(omniSynthQuickStart(true, true)).toContain("omnisynth_tool");
  });
});
