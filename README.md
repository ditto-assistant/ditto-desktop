# Hey Ditto Local

A standalone Mac desktop app for Pi coding tasks with local-first Ditto memory.

The app indexes Git project text files under selected code folders and user/assistant messages from local Codex and Cursor trajectory files. Text is stored in a private SQLite search index. Conversation pairs are also saved to the [Ditto Harness](https://github.com/ditto-assistant/ditto-harness) memory database with its offline hash embedder. Pi receives the most relevant search results and Ditto memories before each task. The app uses Peyton's `@earendil-works/pi-coding-agent` package, the same Pi package used by the Ditto backend runner.

## Run on macOS

Requires macOS on Apple Silicon, Node 22.19 or newer, and Rust/Cargo for the native memory module. If Ollama is running with `qwen2.5:7b` already installed, Pi uses it locally without another sign-in. Other Pi models can be configured through **Open Pi sign-in**.

```sh
npm install
npm run build:native
npm start
```

To build an unsigned local `.app`:

```sh
npm run dist:mac
```

Open `dist/mac-arm64/Hey Ditto Local.app`. The app uses its own macOS Application Support directory and does not touch T3 Code's data.

## Memory and cloud boundary

- First launch starts an incremental local scan; use **Memory → Scan sources** anytime.
- Default code folders include `~/code`, `~/Documents/ChatGPT`, `~/Documents/Codex`, `~/heyditto-stack`, and `~/aiq`. Add or remove folders in Memory. Git tracked and unignored text files up to 512 KB are indexed; common secret files, binary files, dependency directories, and lockfiles are excluded. Obvious credential patterns are redacted before storage.
- Codex sessions under `~/.codex/sessions` and `~/.codex/archived_sessions`, and Cursor agent transcripts under `~/.cursor/projects`, are indexed. Only user and assistant text is ingested.
- Local databases and exports live in macOS Application Support for **Hey Ditto Local**. The app does not upload indexed data automatically.
- **Prepare cloud bundle** writes `cloud-upload-ready.jsonl` in that local directory and reveals it in Finder. The bundle is a staging artifact for a future Ditto cloud ingestion endpoint; exporting does not transmit it.
- **Ditto Account** uses the Ditto API's device-code flow. The resulting key is encrypted with macOS Keychain-backed Electron storage. Linking the account does not upload memory.
- Sending a Pi task shares retrieved memory snippets with the selected Pi model provider. Pi may edit files in the selected workspace. Use **Open Pi sign-in** in the app and choose `/login` to configure a model provider.

The standalone app is independent of the T3 fork. The T3-based `ditto-desktop` repository was used to verify Ditto's existing sign-in and harness contracts.
