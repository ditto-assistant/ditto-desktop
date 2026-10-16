# Building Ditto Desktop

The default `start:desktop` and `build:desktop` commands use the web-style Ditto Desktop shell in `apps/desktop`. There is no separate Local application or repository. The shell also builds a local coding sidecar from the retained T3 provider adapters; it does not start the workbench server or renderer. The existing T3 workbench remains available with `start:desktop:workbench`, `build:desktop:workbench`, and the existing cross-platform release pipeline.

For the Ditto shell, use an Apple Silicon Mac with the repository's Node version, Vite+, Bun, Go, Xcode command-line tools and Rust/Cargo. Initialize `apps/desktop/web/ditto-app` with `git submodule update --init apps/desktop/web/ditto-app`. Access to the Ditto web and memory harness repositories is required. The web revision is pinned so Desktop builds do not silently change with upstream.

Copy `apps/desktop/.env.desktop.example` to `apps/desktop/.env.desktop.local` and fill in the deployment's Firebase configuration. Firebase must allow `https://assistant.heyditto.ai`. The app serves its bundled renderer at that origin. Telegram requires `DITTO_TELEGRAM_API_ID` and `DITTO_TELEGRAM_API_HASH`, or access to the corresponding `PROD_TELEGRAM_*` secrets in `ditto-app-dev`.

```sh
vp install
vp run build:desktop
vp run start:desktop
vp run test:ditto-desktop
vp run dist:desktop:dmg:arm64
```

The distribution command builds an unsigned DMG and an application directory at `apps/desktop/dist-ditto/mac-arm64/Ditto Desktop.app`. For only the application directory, use `vp run dist:desktop:app:arm64`. Release staging uses `package-lock.ditto.json` for the shell's runtime dependencies, avoiding bundling the entire workbench server dependency tree. The provider build produces the worker, its shared SDK chunk and the Claude history worker under `native/provider-runtime`; keep that directory together when staging the app. Keep that lock in sync when changing bundled shell dependencies. The existing signed workbench release path remains separate until the Ditto shell has distribution configuration.

Development uses `apps/desktop/.build/userdata`, or an explicit `DITTO_DESKTOP_HOME`. Packaged upgrades retain bundle ID `ai.heyditto.local` and the existing `hey-ditto-local` Application Support directory to preserve Keychain access, sign-in, memory and Pi sessions. Do not rename or copy that live database while the app is running.

The shell and retained workbench have different host protocols. The shell's maintenance tunnel is `/ditto-desktop/v1`; it must not be routed as the workbench's `/ws` Effect RPC connection. Consolidating those protocols and publishing a shell update feed remain follow-up work. The workbench's remote Desktop update implementation is retained, but it is not enabled for shell builds.
