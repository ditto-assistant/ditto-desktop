# Teleport

Teleport saves a thread's working state to Ditto Cloud so you can pick it up somewhere else: in a
Ditto Code cloud session, on another computer with the Ditto CLI, or back on this one later.

## Link this computer

Teleport uses your Ditto account. Open **Settings → Ditto Account** and choose **Link this
computer**. Ditto shows a short code, opens the approval page in your browser, and the desktop
finishes linking once you approve it. The desktop server keeps its own key; the key never leaves
that machine, and **Disconnect** removes it. You can also revoke it from the Ditto app.

Linking does not need a Ditto sign-in: it works in builds without the `DITTO_FIREBASE_*` values,
where the Ditto Account page shows only the backend picker and **Link this computer**.

## Point the desktop at a preview backend

Teleport talks to whichever Ditto backend **Settings → Ditto Account → Backend** selects:
production by default, or a staging slot. To test a backend branch that is deployed as an ephemeral
preview (a ditto-app pull request whose title carries `[backend:<branch>]` gets
`https://pr-<number>-api.heyditto.ai`), set the per-machine override from the renderer's developer
console and reload:

```js
localStorage.setItem("ditto.apiBaseUrl", "https://pr-2547-api.heyditto.ai");
```

The picker then shows **Preview pr-2547**, and the console logs the active override on every visit to
the settings page so it is never a surprise. Link this computer again after switching backends: the
key is issued by the backend it was linked against. Pick **Production** in the picker (or remove the
`ditto.apiBaseUrl` key) to reset.

## Teleport a thread

Right-click a Claude Code or Codex thread in the sidebar, or open the menu from the chat header, and
choose **Teleport to Ditto Cloud**. The action waits until the current turn has finished so the
saved session is complete. A dialog shows progress while the desktop:

1. bundles every Git repository under the thread's working directory (the directory itself, or each
   repository inside a folder of projects),
2. packs modified and untracked files, leaving out dependency and build folders and anything that
   looks like a secret (`.env` files, keys, credentials),
3. adds the agent's session transcript so the conversation resumes where it stopped,
4. uploads only the pieces Ditto does not already have, then commits a new generation of the
   thread's capsule.

Teleporting the same thread again is fast: unchanged history and files are not uploaded twice.

When the upload finishes, **Open in Ditto Code** starts a cloud session from the capsule and opens it
in your browser. Cloud sessions run on one of your Ditto inference endpoints, so create an endpoint
in the Ditto app first if you have none. If another computer teleported the same thread since your
last push, teleport again to send a full snapshot. On another computer, `heyditto teleport pull` restores the same capsule.

Threads from other providers and threads without a working directory do not offer Teleport.
