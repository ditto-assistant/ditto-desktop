// DITTO: OmniSynth integration.
import { OmniSynthUnavailableError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OmniSynthService from "../../../omnisynth/OmniSynthService.ts";
import { OmniSynthToolkit } from "./tools.ts";

const requireAccess = McpInvocationContext.requireMcpCapability("omnisynth").pipe(
  Effect.mapError(
    () =>
      new OmniSynthUnavailableError({
        reason:
          "OmniSynth access is turned off for this environment. Ask the user to enable it in Settings → Integrations → OmniSynth.",
        installed: false,
      }),
  ),
);

/**
 * Just-in-time guidance returned from `omnisynth_status`. This is the one
 * place the agent learns how to work the DAW, so it lives with the tool result
 * rather than in the always-on prompt block.
 */
export function omniSynthQuickStart(running: boolean, installed: boolean): string {
  if (!installed) {
    return "OmniSynth is not installed on this machine. It is open source: https://github.com/omniaura/omnisynth. Tell the user instead of trying another route.";
  }
  if (!running) {
    return "OmniSynth is installed but not running. Call omnisynth_launch (optionally with a prompt) or ask the user to open it; the tools work once its bridge is up.";
  }
  return [
    "The user has OmniSynth open and hears every change immediately.",
    "For a whole track or a big change, call omnisynth_generate with a vivid prompt (artists, textures, structure, meter) and any image/audio/text paths; it takes minutes and returns the producer's summary.",
    "For precise edits, call omnisynth_state first, then omnisynth_tool with a DAW tool name: add_track / update_track (16 steps of 16n = one 4/4 bar; steps carry prob, ratchet, nudge, cond, lock), create_patch (oscillator, envelope, FM, filter, effects), set_track_fx / set_master_fx, list_params → set_param / automate_param / add_modulation (LFOs, envelope followers for sidechain, random, macros), create_section (bars, beats/unit, bpm) → set_arrangement, set_evolution (markov, cellular, lsystem, genetic, euclid_morph, probability, param_walk every N bars), set_visuals (Hydra), set_view visualizer.",
    "Patterns are JSON step arrays; parameter paths look like acid.fx.2.frequency or master.fx.1.wet.",
    "Do not remove tracks the user did not ask about. Keep going until the request is complete; the DAW is playing while you work.",
  ].join("\n");
}

const handlers = {
  omnisynth_status: (input) =>
    Effect.gen(function* () {
      yield* requireAccess;
      const omnisynth = yield* OmniSynthService.OmniSynthService;
      const status = yield* omnisynth.status({ includeTools: input?.includeTools ?? true });
      return { ...status, quickStart: omniSynthQuickStart(status.running, status.installed) };
    }),
  omnisynth_generate: (input) =>
    Effect.gen(function* () {
      yield* requireAccess;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const omnisynth = yield* OmniSynthService.OmniSynthService;
      return yield* omnisynth.generate({
        prompt: input.prompt,
        attachments: input.attachments ?? [],
        mode: input.mode ?? "iterate",
        source: `ditto-desktop:${scope.threadId}`,
      });
    }),
  omnisynth_tool: (input) =>
    Effect.gen(function* () {
      yield* requireAccess;
      const omnisynth = yield* OmniSynthService.OmniSynthService;
      const result = yield* omnisynth.callTool(input.name, input.arguments ?? {});
      return { result };
    }),
  omnisynth_state: () =>
    Effect.gen(function* () {
      yield* requireAccess;
      const omnisynth = yield* OmniSynthService.OmniSynthService;
      return { state: yield* omnisynth.state };
    }),
  omnisynth_launch: (input) =>
    Effect.gen(function* () {
      yield* requireAccess;
      const omnisynth = yield* OmniSynthService.OmniSynthService;
      const status = yield* omnisynth.launch(input?.prompt);
      return { ...status, quickStart: omniSynthQuickStart(status.running, status.installed) };
    }),
} satisfies Parameters<typeof OmniSynthToolkit.of>[0];

export const OmniSynthToolkitHandlersLive = OmniSynthToolkit.toLayer(handlers);
