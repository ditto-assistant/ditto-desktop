# Ditto Telegram sidecar notices

This independently executable local sidecar is part of Ditto Desktop and is
licensed under the repository's MIT license. It communicates with the desktop
application through a versioned JSON-lines stdio protocol.

It uses `github.com/gotd/td` for Telegram MTProto and
`github.com/zalando/go-keyring` for the device credential store. Both are used
under their MIT licenses. No source from `mautrix-telegram` is included.

The Telegram app credential identifies Ditto; each user's MTProto session is
stored only in that device's credential store. The sidecar must never send a
message without a concrete user action.
