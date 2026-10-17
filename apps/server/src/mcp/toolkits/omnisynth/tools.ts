// DITTO: OmniSynth integration — tools that drive the OmniSynth DAW when it runs on this machine.
import {
  OmniSynthGenerateInput,
  OmniSynthGenerateResult,
  OmniSynthStateResult,
  OmniSynthStatus,
  OmniSynthToolError,
  OmniSynthToolInput,
  OmniSynthToolResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OmniSynthService from "../../../omnisynth/OmniSynthService.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, OmniSynthService.OmniSynthService];

/**
 * Deliberately small: one status verb that also teaches the agent how to use
 * the DAW, one whole-song verb, one proxy for the DAW's own tool catalog, and
 * a state read. The catalog lives in OmniSynth and changes with every release,
 * so wrapping each DAW tool here would only lag behind it.
 */
const OmniSynthStatusTool = Tool.make("omnisynth_status", {
  description:
    "Report whether OmniSynth (the LLM-native DAW) is installed and running on this machine, what is playing, and which DAW tools omnisynth_tool can call. Call this first before any music work; its result explains how to drive the DAW.",
  // An empty struct serializes as `anyOf [object, array]`, which some
  // providers reject and then drop every tool on the server with it.
  parameters: Schema.Struct({
    includeTools: Schema.optional(
      Schema.Boolean.annotate({ description: "Include the DAW tool catalog (default true)." }),
    ),
  }),
  success: OmniSynthStatus,
  failure: OmniSynthToolError,
  dependencies,
})
  .annotate(Tool.Title, "OmniSynth status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const OmniSynthGenerateTool = Tool.make("omnisynth_generate", {
  description:
    "Build or iterate a whole song in OmniSynth from a prompt and optional attachments (image, audio and text file paths). Runs the DAW's Perceive→Orchestrate producer, which designs patches, tracks, sections with their own meters, a mod matrix, evolution rules and visuals, then plays it. Takes one to several minutes; the user watches it happen in OmniSynth. Returns the producer's summary and the song state.",
  parameters: OmniSynthGenerateInput,
  success: OmniSynthGenerateResult,
  failure: OmniSynthToolError,
  dependencies,
})
  .annotate(Tool.Title, "Generate in OmniSynth")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const OmniSynthToolTool = Tool.make("omnisynth_tool", {
  description:
    "Call one OmniSynth DAW tool by name with its arguments: add_track, update_track, create_patch, set_track_fx, set_master_fx, list_params, set_param, automate_param, add_modulation, set_macro, create_section (with its own time signature/tempo), set_arrangement, mutate_pattern, generate_pattern, set_evolution, set_visuals, set_view, play, stop, save_song, get_state and more. omnisynth_status lists them with descriptions; call it when unsure of a tool's arguments.",
  parameters: OmniSynthToolInput,
  success: OmniSynthToolResult,
  failure: OmniSynthToolError,
  dependencies,
})
  .annotate(Tool.Title, "OmniSynth tool")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const OmniSynthStateTool = Tool.make("omnisynth_state", {
  description:
    "Read the current OmniSynth song: tempo, key, tracks with patterns, sections, arrangement, modulations, evolution rules.",
  parameters: Schema.Struct({}),
  success: OmniSynthStateResult,
  failure: OmniSynthToolError,
  dependencies,
})
  .annotate(Tool.Title, "OmniSynth song state")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const OmniSynthLaunchTool = Tool.make("omnisynth_launch", {
  description:
    "Open OmniSynth when it is installed but not running, optionally with a prompt to start generating immediately. Returns once the bridge answers or after a short wait.",
  parameters: Schema.Struct({
    prompt: Schema.optional(
      Schema.String.annotate({ description: "Start a generation as soon as the app opens." }),
    ),
  }),
  success: OmniSynthStatus,
  failure: OmniSynthToolError,
  dependencies,
})
  .annotate(Tool.Title, "Launch OmniSynth")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const OmniSynthToolkit = Toolkit.make(
  OmniSynthStatusTool,
  OmniSynthGenerateTool,
  OmniSynthToolTool,
  OmniSynthStateTool,
  OmniSynthLaunchTool,
);
