# Ditto Desktop

Sign in with Ditto to use the same chats, agents and cloud connections as the web app. Desktop adds local functionality inside that navigation.

## Local coding and memory

In **Code**, choose **Local · Ditto Code** and describe the task. Ditto creates its own private workspace automatically, so you can start without selecting a project. Select a folder when working on an existing project, or choose **Use Ditto workspace** to return to Ditto's workspace. Pi can search for needed folders without changing them. The same composer handles local and cloud requests, with separate drafts and history. Ditto Code runs Pi on this Mac by default. Installed Codex, Claude Code, Cursor Agent and Grok are selectable local engines and require their own sign-in. You can reopen saved conversations for these engines and continue them. Engine permission requests offer **Deny** or **Allow once**; Stop interrupts the engine and keeps its partial reply. Tasks requiring structured follow-up questions currently need the coding workbench. **Cloud · Ditto** uses Ditto's cloud execution.

Desktop settings controls local scanning of project files, Codex sessions and Cursor transcripts. Memory stays in local SQLite databases. **Prepare Ditto import** creates ZIP files for manual upload through Ditto's import screen; creating an export does not upload it. Retrieved context is passed to the model provider chosen for a coding request.

## Local chats

**Chats** includes local Discord, Telegram and iMessage conversations in the same app groups as cloud conversations, with a **Local** badge. Discord and Telegram use local QR sign-in; cloud linking remains a separate connection. Telegram needs application credentials in the build. iMessage needs macOS Full Disk Access. Messages from supported local conversations send as your connected account.

**Use in Ditto Code** creates a local knowledge packet from a conversation and inserts its path into a coding task.

## Browser, Mac control and devices

**Code → Browser · Local** opens Desktop's native browser. Pi has browser tools for navigation, inspection, clicking and filling fields. The **Mac control** checkbox grants access for one task; it requires an unlocked Mac and Accessibility permission. Mac actions operate on controls Pi has inspected.

Desktop settings provides Teleport, Remote Control, Ditto device pairing and coding engine updates. Teleport can transfer the selected project to Ditto Cloud. Remote Control currently hosts Codex, Claude Code or Grok. Paired Desktop shell installations can inspect and update coding engines using the same Ditto device account. Updating the Desktop shell itself remotely needs a published release feed and is not enabled yet.
