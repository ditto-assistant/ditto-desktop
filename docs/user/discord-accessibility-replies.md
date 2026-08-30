# Reply through Discord on macOS

Ditto can use macOS Accessibility to prepare or send a Discord reply without
reading a Discord user token or browser cookie. This is a device-local feature:
Discord must be installed and signed in on the same Mac.

The first time, choose **Enable Accessibility** below the composer and allow
Ditto's Discord helper in **System Settings > Privacy & Security >
Accessibility**. macOS may require Ditto to be restarted after permission is
granted.

Each reply starts only after you press **Send via Discord** or press Enter in
Ditto's composer. Ditto opens the exact Discord conversation link, verifies the
composer's Accessibility label against the selected conversation, inserts the
draft, asks Discord's own Accessibility control to confirm it, and restores
focus to Ditto. Discord can briefly appear while macOS handles the deep link.

If Ditto cannot verify one unique composer, it does not type or send anything.
If Discord accepts the draft but does not expose a deterministic Accessibility
send action, Ditto leaves the draft in Discord and shows **Open Discord** so you
can review it and press Enter yourself.

This transport never sends in the background, on a schedule, or in bulk. It
does not read messages through Accessibility. Conversation history still comes
from the local Discord cache integration, which is also responsible for server
and channel names. Ditto does not crawl Discord's sidebar through Accessibility
to fill missing metadata.
