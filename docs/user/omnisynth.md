# OmniSynth

[OmniSynth](https://github.com/omniaura/omnisynth) is an open-source, LLM-native
DAW for electronic music. When it is installed on the machine that hosts your
environment, Ditto Desktop detects it and gives every agent session a small set
of `omnisynth_*` tools. You can then ask an agent in any thread to make or
change music, and you hear the result in OmniSynth as it happens.

The two apps stay independent: OmniSynth has its own inference settings and
runs without Ditto Desktop; Ditto Desktop works without OmniSynth. Installed
together they share two things — your Ditto account and the agent.

## What "working together" means

- **Agents can produce.** Chat in Ditto Desktop with any provider (Claude Code,
  Codex, Cursor, Grok, OpenCode, the Ditto harness). Say "make a 7/8 acid break
  that evolves" and the agent calls `omnisynth_generate`, or drives individual
  DAW tools through `omnisynth_tool` (tracks, patches, FX chains, the mod
  matrix, sections with their own meter, evolution rules, Hydra visuals).
- **Jobs flow into OmniSynth.** A generate call runs OmniSynth's own
  Perceive → Orchestrate producer. OmniSynth logs the job with the originating
  thread so you can see where a change came from. `omnisynth://generate?prompt=…`
  deep links do the same from anywhere on the machine.
- **One sign-in.** If you have signed in with Ditto in either app, the other
  reuses the session. OmniSynth reads Ditto Desktop's linked account to power
  its inference through Ditto Router; it never writes into Ditto Desktop's
  state. Spend bills to that account's credits, and OmniSynth scales its model
  tier to the balance (frugal / balanced / lavish).

## Requirements

- OmniSynth 0.2 or later, open on the environment's machine. While it runs it
  writes a loopback discovery file (`~/Library/Application Support/OmniSynth/bridge.json`
  on macOS, `%APPDATA%\OmniSynth` on Windows, `$XDG_CONFIG_HOME/omnisynth` on
  Linux) with a per-launch port and token. Ditto Desktop reads that file; there
  is no network discovery and nothing is reachable from other machines.
- Turn on **Settings → Integrations → OmniSynth → Agent OmniSynth access**.
  It is off by default, like device access, and can be overridden per project.

## Tools

| Tool                 | What it does                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `omnisynth_status`   | Installed? running? what is playing, the DAW tool catalog, and how to drive it. Agents call this first. |
| `omnisynth_generate` | Build or iterate a whole song from a prompt and optional image / audio / text paths. Takes minutes.     |
| `omnisynth_tool`     | Call one DAW tool by name (`add_track`, `create_patch`, `add_modulation`, `set_evolution`, …).          |
| `omnisynth_state`    | Read tempo, key, tracks, sections, arrangement, modulations and rules.                                  |
| `omnisynth_launch`   | Open OmniSynth when it is installed but closed, optionally starting a job.                              |

If OmniSynth is closed, `omnisynth_status` says so and the agent can call
`omnisynth_launch` or ask you to open it. If it is not installed, the tools say
that too instead of trying another route.
