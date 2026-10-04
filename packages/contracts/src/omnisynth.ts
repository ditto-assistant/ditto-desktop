/**
 * OmniSynth contracts.
 *
 * OmniSynth (omniaura/omnisynth) is an LLM-native DAW that runs on the same
 * machine as this environment. While it is open it writes a discovery file
 * with a loopback port and a bearer token; the `omnisynth_*` MCP tools call
 * it so an agent in any thread can build or evolve the song. These are the
 * shapes the tools accept and return; the DAW's own tool catalog is read
 * live from the app, so it is not duplicated here.
 *
 * @module omnisynth
 */
import * as Schema from "effect/Schema";

export const OMNISYNTH_BRIDGE_PROTOCOL = 1;

/** The discovery file OmniSynth writes while it runs. */
export const OmniSynthBridgeInfo = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  token: Schema.String,
  pid: Schema.Int,
  version: Schema.String,
  appPath: Schema.String,
  startedAt: Schema.String,
  protocol: Schema.Int,
});
export type OmniSynthBridgeInfo = typeof OmniSynthBridgeInfo.Type;

export const OmniSynthToolSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
});
export type OmniSynthToolSummary = typeof OmniSynthToolSummary.Type;

export const OmniSynthStatus = Schema.Struct({
  /** Installed anywhere we can see (app bundle or a stale discovery file). */
  installed: Schema.Boolean,
  /** Discovery file present and the bridge answered /health. */
  running: Schema.Boolean,
  version: Schema.optional(Schema.String),
  appPath: Schema.optional(Schema.String),
  /** Compact song state from the DAW when running. */
  song: Schema.optional(Schema.Unknown),
  /** Names and one-line descriptions of the DAW tools reachable through omnisynth_tool. */
  tools: Schema.Array(OmniSynthToolSummary),
  /** How to drive it, returned once so threads that never touch music pay nothing. */
  quickStart: Schema.String,
});
export type OmniSynthStatus = typeof OmniSynthStatus.Type;

export const OmniSynthGenerateInput = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      "What to make or change. Reference artists, textures, structure, meter. The DAW's producer agent builds patches, tracks, sections, modulation, evolution rules and visuals from it.",
  }),
  attachments: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description:
        "Absolute paths to images (mood, palette), audio (tempo, key, groove, timbre) or text (lyrics, notes) the producer should perceive.",
    }),
  ),
  mode: Schema.optional(
    Schema.Literals(["new", "iterate"]).annotate({
      description:
        "new clears the current song first; iterate (default) builds on what is playing.",
    }),
  ),
});
export type OmniSynthGenerateInput = typeof OmniSynthGenerateInput.Type;

export const OmniSynthGenerateResult = Schema.Struct({
  summary: Schema.String,
  state: Schema.Unknown,
});
export type OmniSynthGenerateResult = typeof OmniSynthGenerateResult.Type;

export const OmniSynthToolInput = Schema.Struct({
  name: Schema.String.annotate({
    description:
      "A DAW tool name from omnisynth_status (e.g. add_track, create_patch, set_evolution).",
  }),
  arguments: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "The tool's arguments." }),
  ),
});
export type OmniSynthToolInput = typeof OmniSynthToolInput.Type;

export const OmniSynthToolResult = Schema.Struct({
  result: Schema.String,
});
export type OmniSynthToolResult = typeof OmniSynthToolResult.Type;

export const OmniSynthStateResult = Schema.Struct({
  state: Schema.Unknown,
});
export type OmniSynthStateResult = typeof OmniSynthStateResult.Type;

export class OmniSynthUnavailableError extends Schema.TaggedError<OmniSynthUnavailableError>()(
  "OmniSynthUnavailableError",
  {
    reason: Schema.String,
    /** True when the app is installed but closed; the agent can ask the user to open it or call omnisynth_launch. */
    installed: Schema.Boolean,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export class OmniSynthRequestError extends Schema.TaggedError<OmniSynthRequestError>()(
  "OmniSynthRequestError",
  {
    operation: Schema.String,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `OmniSynth ${this.operation} failed: ${this.reason}`;
  }
}

export const OmniSynthToolError = Schema.Union([OmniSynthUnavailableError, OmniSynthRequestError]);
export type OmniSynthToolError = typeof OmniSynthToolError.Type;
