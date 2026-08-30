# Ditto Desktop V2 Plan

**Source:** Omni Aura Weekly Sync, Jun 8 2026 (Gemini notes + transcript), revised after review
**Target:** V2 launch mid-July 2026 (~July 15)
**Owners:** Peyton Spencer + Nick Allen (desktop app); Alan Gothard (T3 agent merge + V2 styling with Sandrock); Omar (app builder / Ditto Home learnings to port)

---

## Where we are

`ditto-desktop` is already a fork of the T3 Code monorepo (`@t3tools`), synced through upstream `v0.0.27`. The meeting decision — "adopt T3 Code as the foundation, customize the ever-loving Jesus out of it" — is structurally done. The web app (`ditto-app`) stays a separate, stable codebase.

**The core V2 work is three things, done in parallel:**

1. **Brand the fork into the canonical Ditto desktop app.**
2. **Set up a durable pipeline that keeps the fork in sync with upstream T3 improvements.**
3. **Turn the local app into one inbox for agent tasks and human conversations.**

Everything else (homepage/chat experience, realtime/live mode, local models, local memories, optional cloud sync) builds on top of that foundation. A Ditto account is never a prerequisite for local channels or local agent tasks; sign-in unlocks mirroring and phone/web continuity.

What T3 gives us for free today:

- Electron shell (`apps/desktop`) + React web UI (`apps/web`) + local Node server (`apps/server`) with SQLite persistence — **fully functional offline, no login required**.
- Harness-orchestrator architecture: provider drivers for Claude, Codex, Cursor, OpenCode, Grok behind a clean SPI (`apps/server/src/provider/`), with worktree management. (This is where a future Ditto coding CLI plugs in — the Grok/ACP provider in upstream PR #2809 is the reference: ~5 additive files + one registry edit.)
- Branding injection seam (`apps/desktop/src/app/DesktopEnvironment.ts` → `apps/web/src/branding.ts`), per-channel icon pipeline, electron-updater release pipeline.
- ACP protocol library (`packages/effect-acp`) with realtime audio event types already in the schema (unwired).

---

## Workstream 1 — Upstream sync pipeline (core)

This is not housekeeping; it's half the value of choosing T3. Upstream moves fast and we want their improvements continuously.

- Add `upstream` remote (`t3tools` repo); document the policy in `docs/forking.md`.
- **Cadence:** weekly upstream merges, ideally automated — a scheduled GitHub Action that opens a "sync upstream" PR (fetch upstream/main, merge, run `vp check` + `vp run typecheck` + desktop smoke test, open PR with conflict report). Conflicts get resolved by a human (or an agent task) on that PR, never on main.
- **Customization discipline so merges stay cheap:**
  - Prefer **additive** files (new routes, new packages, new drivers) over edits to upstream files.
  - Where upstream files must change (branding, shell), keep diffs minimal and tag them `// DITTO:` so conflict resolution is mechanical.
  - Keep Ditto-specific code in clearly-owned directories (e.g., `apps/web/src/ditto/`, `packages/ditto-*`) wherever possible.
- Leave upstream-only surfaces (`apps/marketing`, `apps/mobile`, `infra/relay`) **in-tree and unbuilt** rather than deleting — deletions are permanent merge conflicts.
- MIT license obligations: retain LICENSE, attribute T3 Code in the About screen.

**Deliverables:** `upstream` remote + `docs/forking.md` + sync GitHub Action.

## Workstream 2 — Rebrand to Ditto (core)

Smallest set of seams (per repo audit):

| Surface                                        | Files                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Product name, version                          | `apps/desktop/package.json` (`productName: "T3 Code (Alpha)"` → Ditto)                          |
| App IDs (AUMID, WM class, Linux desktop entry) | `apps/desktop/src/app/DesktopConfig.ts`                                                         |
| Runtime branding injected into web UI          | `apps/desktop/src/app/DesktopEnvironment.ts` (`DesktopAppBranding`), `apps/web/src/branding.ts` |
| Icons per channel (prod/nightly/dev)           | `scripts/lib/brand-assets.ts`, `assets/{prod,nightly,dev}/`                                     |
| Build pipeline                                 | `scripts/build-desktop-artifact.ts`                                                             |
| Favicon/title                                  | `apps/web/src/main.tsx`, build-time icon overrides                                              |
| Update feed URL                                | `ElectronUpdater` feed config — point at our own release host (see Workstream 7)                |

Two passes:

1. **Now:** mechanical rename + placeholder Ditto icons so internal builds say "Ditto". All edits tagged `// DITTO:` per Workstream 1 discipline.
2. **When Sandrock delivers:** real icon set, fonts, dark/light palettes, styling uplift to "Venice quality" (Seby's bar). Keep theme changes in CSS variables/tokens so the styling pass doesn't touch logic — and so a future malleable-UI-settings feature can drive them.

## Workstream 3 — Homepage experience: chat, realtime/live mode, local models

This is the product layer that makes the fork _Ditto_ rather than a rebranded T3. T3 has no homepage — "it assumes you know what you're going to do." We build one. This is a **rewrite, not a port**: ditto-app is SolidJS, this stack is React 19 + TanStack Router; nothing transplants.

- **Home route:** prompt bar front-and-center (Venice reference), recent chats/tasks, entry points into the coding workspace. New TanStack route tree (e.g., `apps/web/src/routes/_home.*` or `_ditto.*`) alongside the existing `_chat.*` coding routes — Claude-app-style mode toggle between **Ditto** (home/chat) and **Code** (T3 workspace), with App Builder reserved as a future third mode.
- **Chat v1:** minimal new chat UI in T3's React stack, talking to a local coding-agent/model provider by default and the Ditto backend only when the user opts into cloud mode. Don't recreate ditto-app's full ChatFeed; scope to a clean streaming conversation view.
- **Realtime/live mode:** voice-driven live interaction on the homepage. The ACP schema already defines `thread.realtime.audio.delta` and audio capability flags but nothing is wired to UI. Scope v1 deliberately: mic capture in the renderer (`getUserMedia`) → STT → prompt → streamed/spoken response; design the event plumbing against the existing ACP audio types so a true duplex realtime mode can follow without rework.
- **Local model ability:** detect hardware (RAM / Apple Silicon), recommend + download an appropriate model (Gemma-class for 16–32GB Macs). Cheapest path: an **Ollama provider driver** — upstream tests already mention `ollama` as a driver kind and the driver SPI is open, so this rides the existing provider seam. Evaluate the 0xero T3 fork (local AI) for reusable patterns first. The local model serves homepage chat in offline mode.
- **Sidebar:** evolve into "all your chats" now: agent tasks and human conversations in one search-first, filterable timeline (`apps/web/src/components/Sidebar.tsx`, `AppSidebarLayout.tsx`).

## Workstream 3A — Universal inbox and local channel runtime (core)

The product promise is simple: a user can stop opening Discord, Telegram, Slack, Messages, and the rest. Ditto shows their conversations, lets them use every operation that the connected transport actually supports, and—after optional sign-in—mirrors selected conversation events to Ditto cloud memories so the same history is available on phone and web.

This is not a Beeper dependency and not an MCP-only feature. It is a first-class desktop subsystem with a normalized local event store and provider adapters.

### Local-first operating model

- The desktop app starts in **local profile** mode with no Ditto account, no cloud credentials, and no network dependency beyond the chat services a user explicitly connects.
- Channel credentials stay in the OS keychain or the provider's own app/config. Normalized messages, cursors, capability snapshots, and outbox state live in local SQLite.
- Sign-in is an additive upgrade. It creates a sync identity and lets the user opt individual accounts/conversations into Ditto cloud-memory mirroring. Local data remains usable after sign-out.
- Imported messages carry stable source identities (`transport`, `account_id`, `conversation_id`, `message_id`) so retries and multi-device sync are idempotent.
- Cloud sync is an application-level event log, never database replication. Every event records provenance, edit/delete state, attachments, and a privacy/sync policy.

### Transport model: hosted and device can coexist

One service may expose more than one transport for the same account. Ditto chooses per operation, not per logo.

| Service / transport                        |                               Local read |                           Local send |        Hosted read/send | Initial implementation                                                                                                 |
| ------------------------------------------ | ---------------------------------------: | -----------------------------------: | ----------------------: | ---------------------------------------------------------------------------------------------------------------------- |
| Discord Desktop cache via Discrawl wiretap |         Cached guilds + classifiable DMs |                                   No |                      No | Bundle/supervise Discrawl; import/search locally. Discrawl deliberately does not extract user tokens or run a selfbot. |
| Discord macOS Accessibility                |               No additional history read |      Explicit user action on the Mac |                      No | Deep-link and verify one composer; send only through deterministic AX confirm, otherwise leave a reviewed draft.       |
| Discord bot via Discrawl + Discord API     |                Bot-visible guild history |                    Bot identity only |                     Yes | Discrawl for archive/search; official bot API/Gateway for live events and sends.                                       |
| iMessage on macOS                          | Messages database, with Full Disk Access | AppleScript/automation, with consent |                      No | Local adapter following the Messages DB + Apple Events pattern.                                                        |
| Telegram bot                               |                        Bot-visible chats |                         Bot identity |                     Yes | Bring-your-own bot token in keychain; official Bot API.                                                                |
| Telegram user session                      |                    Account-visible chats |                        User identity | Optional hosted session | Later, only through an approved client API flow and explicit session custody.                                          |
| Slack app                                  |          Granted workspace/channel scope | App identity or delegated user scope |                     Yes | Official Slack APIs; hosted and device-local workers share the same adapter contract.                                  |
| WhatsApp                                   |               Depends on local companion |          Depends on approved surface |            Business API | Spike after Discord/iMessage; do not promise unsupported personal-account automation.                                  |

**Discord constraint:** Discrawl is the high-performance local archive/index, not a personal-account sender. Device-cache rows may be incomplete because they only include data Discord Desktop has cached. Personal user-token/selfbot automation is out of scope. The UI must show whether a conversation is cache-only, bot-readable, or bot-writable.

### Capability contract

Every connected account publishes a runtime capability snapshot. The composer and message menus render from this snapshot rather than assuming parity:

- read history, live events, send, reply, edit, delete;
- reactions, threads, mentions, typing/read state;
- attachments, embeds, polls, voice notes, calls;
- identity mode (`user`, `bot`, or `archive`) and execution location (`device`, `hosted`, or both);
- completeness/freshness and the permission or setup action blocking a capability.

Unsupported operations are visible as unavailable with a concrete reason; Ditto never silently falls back to a less-trusted identity or UI automation path.

### Delivery stack

1. **Foundation:** normalized contracts, account registry, adapter SPI, local SQLite event/outbox store, capability snapshots, anonymous local profile, and optional cloud-sync seam.
2. **Discord + iMessage:** Discrawl discovery/wiretap/search plus Discord bot mode; macOS Messages read/send with permission diagnostics.
3. **Unified UI:** inbox/conversation routes, account badges, capability-aware composer, attachments/reactions/threads as adapters expose them, and agent actions over selected conversations.
4. **Telegram + Slack:** official bot/app transports first; hosted workers reuse the same event schema and idempotency keys.
5. **Cloud continuity:** opt-in encrypted credential custody where needed, selected-conversation memory mirroring, mobile/web read and reply routing, export/delete controls, audit history.

### Security and policy rails

- Explicit per-account consent and per-conversation cloud-sync controls; DMs default local-only until the user opts in.
- Secrets never enter SQLite, logs, agent prompts, memory payloads, or Git-backed archives.
- Adapter-specific ToS review and kill switches. Official APIs are preferred; local accessibility/automation is separately disclosed and permission-gated.
- The agent sees normalized content through scoped tools. Sending, deleting, editing, reacting, or broad sync are distinct auditable actions with confirmation policy.
- Retention, export, disconnect, and delete-local/delete-cloud controls ship with the first cloud mirror—not afterward.

## Workstream 4 — Local memories: Go sidecar + storage engine

1. **Go memories sidecar:** compile the Go memory service from `backend` into a per-platform binary, ship via electron-builder extraResources, spawn/supervise from `apps/desktop/src/main.ts` (same pattern as the existing local Node server).

2. **Storage engine decision.** Embedded Postgres is rejected (analysis below). The real choice is **plain SQLite vs Turso**:

   **Why not embedded Postgres:** Postgres is a client/server system, not an embeddable library. Bundling it means full server binaries per platform/arch (~40MB each), `initdb` on first launch, a separate daemon to supervise (crash recovery, orphans on force-quit), port/socket management that must not collide with a user's real Postgres, Windows permission quirks and antivirus false-positives on a bundled `postgres.exe` — and, worst, **major-version upgrades**: data directories aren't forward-compatible, so an auto-updating app must ship `pg_upgrade`/dump-restore logic where one failed migration bricks the user's local brain. The Docker variant adds Docker Desktop as an install dependency and is strictly worse. SQLite-family engines are in-process: one file, no daemon, no ports, stable file format, and backup/export is "copy the file" — which aligns exactly with the signed passport export.

   **Option A — plain SQLite** (via `modernc.org/sqlite` pure-Go, or `mattn/go-sqlite3` cgo):
   - ✅ Boring, battle-tested, zero operational surface. T3's own local server already uses SQLite, so the whole app converges on one storage philosophy.
   - ✅ sqlc supports SQLite; the team accepts handwriting the queries that don't translate from Postgres.
   - ⚠️ Vector search needs an extension (`sqlite-vec`) — loading extensions is awkward with pure-Go drivers (pushes toward cgo, or compiling sqlite-vec in).

   **Option B — Turso** (`tursodatabase/turso`, the Rust SQLite rewrite, formerly Limbo):
   - ✅ SQLite-compatible file format and SQL dialect — everything in Option A's favor mostly carries over.
   - ✅ **Native vector search built in** — no extension juggling; memories need embedding search locally, so this is the headline argument for Turso.
   - ✅ Async I/O design; the project has momentum, and the team has prior Turso/libSQL experience from the old backend.
   - ✅ Their offline/embedded-sync story (embedded replicas, CDC) is interesting _if_ we ever want SQLite↔cloud-SQLite device sync — but note our cloud is Postgres, so Turso's sync doesn't solve our actual sync problem.
   - ⚠️ **Maturity risk:** the Rust rewrite is still pre-1.0/beta-grade; Go bindings are young. A corrupted or buggy local store is a user's _memories_ — the blast radius of an immature engine is high here.
   - ⚠️ sqlc has no Turso-specific support; we'd target its SQLite dialect and hope for full compatibility.

   **Recommendation:** Build the Go memories service against the `database/sql` SQLite dialect with the storage driver behind a thin interface, ship **plain SQLite + sqlite-vec for V2**, and keep **Turso as a drop-in candidate** to re-evaluate post-V2 (it gets the same file format and dialect, so swapping is cheap if their Go story matures). Decide W1 with Omar/Nick Anderson — the one thing that could flip this to Turso-now is if sqlite-vec integration in Go turns out uglier than Turso's native vectors.

3. **The sync wrinkle (acknowledged hairy, no way around it):** local SQLite memory store ↔ cloud Postgres. Mitigation is to **never sync at the database level** — sync at the application/API layer so the engines don't need to match:
   - Treat memories as an append-mostly log with globally unique IDs (ULIDs) and updated-at timestamps; last-write-wins per record for V2 (no merge semantics).
   - The signed passport export format is the natural v1 transport for the initial "upload my local brain" bulk flow; incremental sync is a cursor-based push/pull against existing backend APIs.
   - sqlc on both sides: Postgres queries stay first-class in the backend; the SQLite side handwrites what doesn't translate. Keep the memory-service query layer behind an interface so the two implementations diverge in queries, not in shape.

## Workstream 5 — Accounts & cloud sync (the conversion funnel)

- Funnel: use locally for free → want phone/cross-device sync → create Ditto account → memories sync to cloud (via Workstream 4's sync layer).
- **Auth decision:** T3 ships optional Clerk auth + a Cloudflare/Planetscale relay (`infra/relay`, "T3 Connect"). We run neither. Recommendation: leave Clerk dormant (no publishable key = disabled) and add Ditto Firebase auth alongside, behind the same `managedAuth.tsx` conditional seam — touches fewer upstream files than rip-and-replace; remove Clerk post-V2.
- Keep T3's environment-pairing/relay features out of scope for V2.

## Workstream 6 — Deferred product modes

- **Ditto Code as a harness:** deferred until we build a coding CLI (today's Ditto Code = OpenHands in our cloud; nothing to plug into the local harness picker). When ready: `DittoDriver.ts` + adapter via ACP-over-stdio, following the Grok provider pattern (`apps/server/src/provider/Drivers/GrokDriver.ts`, registered in `builtInDrivers.ts`).
- **App Builder mode:** third mode toggle, riding the harness infra as a guided on-rails experience; port learnings from Omar's Ditto Home + the ditto-app app builder. Custom-domains UI lands here when the backend "official custom domains" work ships.
- **Malleable UI settings:** Nick Anderson's natural-language UI-settings DB (ditto-app branch) — design later against T3's settings persistence; Workstream 2's token-based theming should be built so this can drive it.

## Workstream 7 — Release & update pipeline

- Stand up our own update feed (electron-updater `feedURL` is configurable) — GitHub Releases on `ditto-assistant/ditto-desktop` or R2/S3.
- Wire `scripts/build-desktop-artifact.ts` into CI for mac (arm64/x64 DMG), Windows (NSIS), Linux (AppImage); keep `latest` + `nightly` channels.
- macOS signing/notarization with our Apple Developer cert; Windows signing decision.
- Single-app security audit (Seby: "one audit that we pay for, audits everything") — schedule after local memories land.

---

## Sequencing (≈5 weeks to July 15)

| Week         | Milestone                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **W1 (now)** | Mechanical rebrand pass (builds say "Ditto"). Upstream remote + sync GitHub Action + `docs/forking.md`. Storage-engine decision (SQLite vs Turso) with Omar/Nick Anderson. |
| **W2**       | Home/mode shell plus channel contracts, local profile, adapter registry, SQLite event/outbox schema. Basic Ditto chat from PR #1.                                          |
| **W3**       | Discord Discrawl device archive + bot transport; iMessage permission/read/send adapter; unified inbox skeleton.                                                            |
| **W4**       | Go memories sidecar, local model, Telegram/Slack official transports. Optional Ditto auth and selected-conversation sync spike.                                            |
| **W5**       | Capability-aware composer and hardening, realtime/live mode, release pipeline, signing, consent/export/delete controls. Freeze + dogfood.                                  |
| **Post-V2**  | More platform feature parity, WhatsApp approved transport, App Builder, custom domains UI, malleable UI settings, Turso re-evaluation, security audit, Clerk removal.      |

## Open decisions (resolve in W1)

1. **Storage engine:** plain SQLite + sqlite-vec (recommended) vs Turso now. Flip condition: sqlite-vec-in-Go integration pain vs Turso's native vectors.
2. **Upstream sync automation:** scheduled action opening sync PRs — who owns conflict resolution duty?
3. **Auth:** Ditto Firebase auth alongside dormant Clerk (recommended) vs rip-and-replace now.
4. **Realtime v1 shape:** push-to-talk STT loop (recommended) vs full duplex realtime from day one.
5. **Existing Electron wrapper:** Nick Allen's earlier wrapper of the web app is superseded (acknowledged in the meeting) — confirm archive/retire so there's one desktop codebase.
6. **Cloud message scope:** default all conversations to local-only; decide which explicit user action opts a conversation into cloud-memory mirroring.
7. **Hosted credential custody:** choose the encrypted secret-store and revocation model before any hosted reply transport ships.
