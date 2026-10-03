# Ditto Desktop

Ditto's web app, built from the pinned `ditto-app` source and bundled inside an Electron app, with additional private Mac memory and coding tasks. The desktop window uses Ditto's normal Firebase sign-in and the same Chats, Code, agents, Connections, and conversations as the web app. Its window and Dock name are **Ditto Desktop**. The Chats sidebar has an **On this Mac** group for local Discord, Telegram, and iMessage accounts; the Code sidebar has a **Ditto Code** entry for Pi and local memory. The app does not load the hosted web UI into a second window.

The UI is sourced from `ditto-app` main at `8cf8ad6a3`. The rounded Tide blue icon follows the web PWA and Brandkit at `8e3da6a8e`. The product is independent of the T3 fork.

## Build and run on macOS

Requires Apple Silicon macOS, Node 22.19 or newer, Bun, Go, and Rust/Cargo for the native memory module. Clone with submodules, or run `git submodule update --init --recursive` after cloning.

Copy `.env.desktop.example` to `.env.desktop.local` and fill in the Firebase values for the Ditto deployment. Use an API key allowed for `https://assistant.heyditto.ai`; the desktop app serves bundled code at that origin so Firebase sign-in and existing account sessions work. Set `VITE_DITTO_API_BASE` to the matching Ditto API. The local env file is ignored by Git and is removed from the web checkout after each build.

```sh
npm install
npm run build:native
npm run build:web
npm run build:channels
npm start
```

Build the installable app with `npm run dist:mac`. It appears at `dist/mac-arm64/Ditto Desktop.app`. The app preserves its existing `hey-ditto-local` Application Support directory and bundle ID, so upgrading keeps local memory, Pi settings, and the previous Ditto Connections sign-in. The new bundle name and Dock icon are **Ditto Desktop**.

## What the navigation contains

- **Chats:** Ditto chats and linked Discord, Slack, Telegram, and other cloud conversation sources. The **On this Mac** group opens locally connected Discord, Telegram, and iMessage. Local Discord and Telegram sign-in uses a QR code; iMessage needs macOS Full Disk Access to read local Messages. Sending a reply happens only when you click **Send as me**.
- **Code:** Opens local Ditto Code with Pi by default. The Code sidebar has explicit **Local · Ditto Code** and **Cloud · Ditto** choices. Local mode shows local task history; cloud mode shows cloud projects and tasks. Both keep the same web chat composer mounted.
- **Customize:** Ditto's agents and integrations.
- **Connections:** Linked app status and management through the same signed-in desktop window.
- **Chats → On this Mac:** Read and reply to local conversations. **Use in Ditto Code** creates a private knowledge packet, including bounded chat history and supported attachments, and inserts its path into a coding task.
- **Code → Local · Ditto Code:** Runs Pi on this Mac using private memory from selected Git project text and Codex/Cursor user and assistant trajectories. Choose a project folder before the first run; local coding is not launched from your entire home directory. Pi conversations persist across follow-up requests and can be resumed from the local task list. Memory, scanning, export, permissions, Remote Control, and Teleport are available in Desktop settings. Select an installed Codex, Claude Code, Cursor Agent, or Grok CLI to dispatch a task locally through that engine. Each engine uses its own local sign-in; Claude Code must be signed in before it can complete a run.
- **Code → Cloud · Ditto:** Opens the existing end-to-end Ditto cloud task composer and project history.
- **Code → Browser · Local:** Opens a native Chromium browser pane in Ditto Desktop. Pi can open HTTP/HTTPS pages, inspect visible text and controls, fill fields, click, and navigate through dedicated browser tools. Browser pages stay in a separate Electron session from Ditto sign-in.
- **Code → Local · Ditto Code → Mac control:** Each Pi task can be given one-shot macOS Accessibility access with its checkbox. The Mac must be unlocked and the bundled computer helper must have Accessibility permission. Desktop settings opens the macOS permission page and can recheck access. Password fields are masked in snapshots, including secure text-field subroles. Pi can inspect the frontmost app, activate a running app by bundle ID, press a listed element, and set a listed field. Actions validate the observed app, process, and control labels, and consume the snapshot so the next action requires another inspection.
- **Code → Local · Ditto Code → Remote Control:** Choose a Ditto inference endpoint and start a headless Codex, Claude Code, or Grok host. The linked device list shows registered hosts; a remote task sent from Ditto runs on this Mac while the host is active.
- **Desktop settings → Your Ditto devices:** Connect this Mac using its Ditto device link, create a six-digit pairing code, and claim it on another Mac signed in to the same Ditto account. The connection persists across restarts until disconnected or signed out. Paired Macs running this standalone build can inspect and update each other's coding engines. Unpairing closes that peer's environment tunnels.
- **Desktop settings → Coding engines:** Check installed versions and update supported npm, Homebrew, or native installations. The updater verifies the executable's original installer, refuses unknown installations, and waits for coding tasks and other updates to finish. Engines bundled with Ditto Desktop, or another vendor's app such as ChatGPT, are updated through that app.
- **Code → Local · Ditto Code → Teleport:** Preview a selected project, push a capsule, or request a Ditto Cloud continuation. The preview stays local. Pushing transfers the selected project to Ditto; the cloud action also requests a remote coding session and currently uses a personal inference endpoint.

The desktop renderer is copied from the pinned web source at build time, with native entries in the web app's left navigation. Electron serves those copied files locally under Ditto's web origin and forwards other HTTPS requests normally. It clears any old PWA worker on launch to prevent a stale hosted build from replacing the bundled UI.

## Local memory and cloud boundary

First launch starts an incremental local scan. Default code folders include `~/code`, `~/Documents/ChatGPT`, `~/Documents/Codex`, `~/heyditto-stack`, and `~/aiq`. Git tracked and unignored text files up to 512 KB are indexed; common secret files, binary files, dependency directories, and lockfiles are excluded. Obvious credential patterns are redacted before storage. Codex sessions in `~/.codex/sessions` and `~/.codex/archived_sessions`, and Cursor agent transcripts in `~/.cursor/projects`, are indexed. Only user and assistant text is ingested.

Text is stored in a private SQLite search index. Conversation pairs are also saved to the Ditto Harness memory database with its offline hash embedder. Pi receives relevant local search results and Ditto memories when a conversation starts. Follow-ups resume its own Pi session with recent conversation context, while local run history is stored in SQLite. If Ollama is running with `qwen2.5:7b`, Pi uses it locally; other models can be configured through Pi sign-in. The other coding engines run through their installed local CLIs and use their own account sign-in.

Pi runs in a macOS filesystem sandbox: it can read local context, but writes are limited to the chosen project folder and its private Pi settings and temporary directories. Installed coding engines use their own CLI approval policies. Choose a project folder explicitly before any local code execution; the home directory is not accepted as a working folder.

**Prepare Ditto import** creates local ZIP archives and opens them in Finder. In Ditto, use Settings → Import → Markdown/notes to upload them. Exporting does not transmit data. The earlier `cloud-upload-ready.jsonl` format remains available through `MemoryStore.exportCloudBundle()` for local tooling. Local chat histories are read only when you open a conversation or create a knowledge packet; they are not silently copied into the local code index. Sending a coding task shares retrieved snippets and any referenced packet with the selected model provider. Coding engines may edit files in the chosen workspace.

The previous MCP device-code link is retained for compatibility with local tooling, but the main desktop app uses the web app's Ditto authentication session. The local memory database and Pi settings stay in macOS Application Support for `hey-ditto-local` to preserve existing data.

Remote Control, Teleport, and device pairing use a Ditto CLI key saved in the macOS Keychain-backed desktop account file. Browser use and Mac control are local Pi tools. The bundled CLI's host bridge exposes coding sessions across signed-in devices. A separate Desktop host connection uses the backend's authenticated environment tunnel for engine maintenance. Its versioned `/ditto-desktop/v1` protocol supports only Desktop status, engine status, and engine updates; it does not implement the T3 Effect RPC protocol. Commands from unpaired peers, arbitrary shell commands, and unknown methods are rejected. Duplicate update requests are retained for ten minutes so reconnect delivery cannot start the same update twice. This service does not announce a Pi coding session to the cloud orchestrator; the existing headless Remote Control engines remain Codex, Claude Code, and Grok.

Automatic updates of the Desktop application itself require a published Ditto release feed and distribution credentials. This private repository currently has no release feed; remote Desktop self-update is not implemented. Pi and bundled Grok updates are delivered with a new Desktop build. Live registration and an owner-authenticated environment status request were verified against the Ditto backend. Pairing restrictions, update deduplication, and outgoing paired requests are covered by local integration tests. Installations on a second physical Mac and full remote update dispatch still need end-to-end verification.

Local connection health is recorded in bounded `channel-health.jsonl` files in Application Support. These record operation names, timing, connection flags, and result counts. They exclude credentials, QR codes, account identifiers, conversation names, and message contents. Local sign-in is separate from cloud linking. Telegram requires its application credentials at build time; an unconfigured build displays setup guidance and does not offer a broken login.
