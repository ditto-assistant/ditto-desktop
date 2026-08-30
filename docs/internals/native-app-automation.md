# Native app automation adapters

Ditto's local chat transports may need to observe or act through an installed
desktop app when the provider offers no suitable user-identity API. This is a
narrow app-integration boundary, not general computer use.

## Architecture

Each concrete adapter implements `AppScopedAutomationAdapter` and publishes:

- one canonical application identity (`bundleId`);
- a stable target made from the adapter, account, container, and conversation
  IDs, with display text used only as corroborating metadata;
- explicit capabilities for semantic observation, draft, commit, cursorless and
  background operation, lock-screen support, and intervention detection;
- typed status, snapshot, mutation receipt, timeout, cancellation, and
  idempotency behavior.

The desktop main process is the authority boundary. The sandboxed renderer may
request an operation through typed IPC, but it cannot invoke a native helper or
choose an executable. A native helper receives one bounded command over an
inherited stdin/stdout pipe. This gives the current Discord integration a
private parent-owned channel without a localhost port or discoverable shared
socket.

If an adapter later needs a persistent helper for event subscriptions, it must
use authenticated Unix/XPC IPC. The broker must resolve the caller from the
connection audit token, verify Ditto's signing identity and responsible-process
ancestry, cap message sizes, version its protocol, apply deadlines, and
serialize mutations per canonical target. Merely hiding a socket path is not
authentication.

## Semantic operation lifecycle

1. `resolveTarget` validates stable provider IDs and returns a canonical app
   target. A title alone can never authorize a mutation.
2. `snapshot` observes only the selected app/window and returns bounded semantic
   state. Future persistent drivers will also return an opaque revision and
   short-lived element handles.
3. A typed `perform` action re-resolves the target, sets the exact composer
   value without global keyboard or pointer input, and verifies the observed
   draft. In prepare mode it stops here and returns the verified draft state.
4. In send mode, the same bounded `perform` action rechecks the target and exact
   draft before invoking the explicit semantic send action. A future persistent
   driver API may expose these prepare and commit phases as separate methods.
5. The adapter returns an audited receipt and verifies the postcondition. A
   cleared composer without corroborating message evidence is not necessarily a
   confirmed send.

Any app/window change or target-scoped user activity invalidates semantic
handles. The caller must take a fresh snapshot before retrying. One user
interacting with Discord should not block unrelated Telegram or Slack adapter
sessions.

## Focus, pointer, and lock policy

The v1 Discord helper uses cursorless Accessibility value/action calls and
best-effort background operation. It may briefly activate an internal app
surface when macOS requires it, then restores the previously frontmost app.
Global coordinates and physical-pointer movement are not acceptable fallbacks.
An enforceable `never_activate` policy belongs to a future request-context API;
the current adapter does not claim that guarantee.

The macOS login window is a separate security boundary. The initial Ditto
driver reports locked-session control as unsupported and fails closed when the
session is locked. A keep-awake assertion does not bypass the lock screen.
Building a guarded automatic-unlock product would require separate privileged
installation, security review, explicit consent, intervention monitoring, and
relocking; it is not part of a chat adapter.

## Discord v1

`DiscordAccessibilityTransport` is the first concrete adapter. Its descriptor
is `discord-accessibility` / `com.hnc.Discord`. It supports semantic live
observation and draft insertion, cursorless operation, best-effort background
commit and intervention behavior, and no locked-session operation.

The current native helper is deliberately fail-closed. Its semantic commit is
best-effort because Discord's Electron Accessibility tree does not consistently
expose a send action while backgrounded. The next Discord driver may add an
explicitly enabled Chrome DevTools Protocol transport for renderer-scoped
snapshot, draft, and commit. That transport must bind only to loopback, verify
the Discord process/bundle and target URL, negotiate against Discord's bundled
Chromium protocol, and never expose an unauthenticated debugging endpoint beyond
the user-approved session.

The public building blocks are documented by Apple and Electron: Accessibility
actions, ScreenCaptureKit window filtering, Electron's remote-debugging switch,
and the Chrome DevTools Protocol Accessibility, DOM, DOMSnapshot, and Input
domains. Discord policy and legal review remain separate from the technical
capability.
