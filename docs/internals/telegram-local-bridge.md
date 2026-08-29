# Telegram local bridge

The desktop inbox has one stable Telegram account id, `telegram:desktop:local`, and delegates it to
a `TelegramChannelSource`. Signed-out desktop selects the bundled macOS source. A signed-in build can
select a Ditto Cloud source at operation time without changing inbox routes or rendering duplicate
local/cloud accounts.

## Security boundary

The local source does **not** parse Telegram `tdata`, copy a Telegram session, extract an MTProto auth
key, or impersonate the user over an unofficial client connection. Telegram Desktop's own source
shows that account metadata and its local key are stored in encrypted `tdata` records. TDLib is not a
zero-login reuse mechanism: its documented initialization requires an `api_id`, `api_hash`, a
separate database directory, and the full user authorization state machine.

Instead, the bundled `ditto-telegram-ax` helper reads the screen-reader view exposed by the already
signed-in Telegram Desktop process. A send is allowed only after an explicit Ditto click, an official
`tg://resolve?domain=...` deep link, and a unique Accessibility composer match. Message text is set
only after that match. The helper does not activate Telegram and fails closed if it cannot verify the
destination.

Primary references:

- [Telegram Desktop local storage implementation](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/storage/storage_domain.cpp)
- [TDLib initialization and authorization](https://core.telegram.org/tdlib/getting-started)
- [Telegram deep-link specification](https://core.telegram.org/api/links)
- [Telegram Desktop screen-reader work](https://github.com/telegramdesktop/tdesktop/blob/dev/changelog.txt)

## Current compatibility

- Telegram Desktop 6.9+ (`org.telegram.desktop`): local screen-reader snapshot and verified public
  username sends are enabled after Accessibility permission.
- Native Telegram for macOS (`ru.keepcoder.Telegram`): detected, but currently reports setup required.
  Its window does not expose chat/message controls in the macOS Accessibility tree, so Ditto refuses
  to scrape pixels or send to an unverifiable destination.
- Private chats without a public username: readable when exposed by Telegram Desktop, but local send
  remains disabled because Telegram has no exact deep link for the opaque AX row.
- History is a partial view of what Telegram Desktop exposes to its screen reader; it is not a full
  Telegram export and does not claim cache completeness.
- Attachments, reactions, edits, deletes, replies, and secret chats are not implemented in this first
  layer.

## Manual QA

1. Install/sign in to Telegram Desktop 6.9 or newer, then start Ditto Desktop without signing in.
2. In Inbox, expand Telegram and click **Enable Telegram access**.
3. Grant the bundled helper under System Settings → Privacy & Security → Accessibility.
4. Confirm chat rows and the currently exposed message history appear without Telegram taking focus.
5. Open a public-username chat and use **Open in Telegram**; confirm macOS routes the `tg:` URI to the
   app rather than a browser.
6. Type a harmless test draft in Ditto and click send. Confirm the helper sends only in the exact
   verified chat. No test should be performed against a third party without their consent.
