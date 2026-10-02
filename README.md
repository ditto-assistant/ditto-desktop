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
- **Code:** Ditto's web Code projects and tasks.
- **Customize:** Ditto's agents and integrations.
- **Connections:** Linked app status and management through the same signed-in desktop window.
- **Chats → On this Mac:** Read and reply to local conversations. **Use in Ditto Code** creates a private knowledge packet, including bounded chat history and supported attachments, and inserts its path into a coding task.
- **Code → Ditto Code:** Private Mac memory from selected Git project text and Codex/Cursor user and assistant trajectories. Search, scan, choose code folders, export, and inspect saved local executions. Pi is the default coding engine; installed Codex, Claude Code, Cursor Agent, and Grok CLIs are available in the engine selector.

The desktop renderer is copied from the pinned web source at build time, with native entries in the web app's left navigation. Electron serves those copied files locally under Ditto's web origin and forwards other HTTPS requests normally. It clears any old PWA worker on launch to prevent a stale hosted build from replacing the bundled UI.

## Local memory and cloud boundary

First launch starts an incremental local scan. Default code folders include `~/code`, `~/Documents/ChatGPT`, `~/Documents/Codex`, `~/heyditto-stack`, and `~/aiq`. Git tracked and unignored text files up to 512 KB are indexed; common secret files, binary files, dependency directories, and lockfiles are excluded. Obvious credential patterns are redacted before storage. Codex sessions in `~/.codex/sessions` and `~/.codex/archived_sessions`, and Cursor agent transcripts in `~/.cursor/projects`, are indexed. Only user and assistant text is ingested.

Text is stored in a private SQLite search index. Conversation pairs are also saved to the Ditto Harness memory database with its offline hash embedder. Pi receives relevant local search results and Ditto memories before each task, and local run history is stored in SQLite. If Ollama is running with `qwen2.5:7b`, Pi uses it locally; other models can be configured through Pi sign-in. The other coding engines run through their installed local CLIs and use their own account sign-in.

**Prepare Ditto import** creates local ZIP archives and opens them in Finder. In Ditto, use Settings → Import → Markdown/notes to upload them. Exporting does not transmit data. The earlier `cloud-upload-ready.jsonl` format remains available through `MemoryStore.exportCloudBundle()` for local tooling. Local chat histories are read only when you open a conversation or create a knowledge packet; they are not silently copied into the local code index. Sending a coding task shares retrieved snippets and any referenced packet with the selected model provider. Coding engines may edit files in the chosen workspace.

The previous MCP device-code link is retained for compatibility with local tooling, but the main desktop app uses the web app's Ditto authentication session. The local memory database and Pi settings stay in macOS Application Support for `hey-ditto-local` to preserve existing data.
