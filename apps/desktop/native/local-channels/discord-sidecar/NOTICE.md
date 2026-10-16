# Ditto Discord sidecar notices

This directory is an independently executable local sidecar and is licensed
under the GNU Affero General Public License, version 3.0 only. It communicates
with the MIT-licensed Ditto desktop application through a versioned JSON-lines
stdio protocol.

The remote-auth implementation is adapted from the `remoteauth` package in
[`mautrix-discord`](https://github.com/mautrix/discord) at commit
`c62165a46109d7c824bc0b4bb067ba02ea6528f1`, specifically its remote-auth
packet, client, and user flow plus the prepared-attachment upload behavior in
`portal.go` and `attachments.go`. That source is licensed under AGPL-3.0. The
adaptation adds context cancellation, deterministic result delivery, bounded
writes, and a Ditto-specific protocol surface.

The Discord protocol client is Beeper's fork of `discordgo`, used under its
BSD-3-Clause license. The Go module intentionally imports
`github.com/bwmarrin/discordgo` and pins the Beeper fork with a `replace`
directive because the fork retains the upstream module path.
The pinned fork commit is `8051e14a447170269a615268c4d83b55e6fcf2fe`.

This component uses undocumented Discord client behavior. It is not endorsed
by Discord and may stop working or expose the connected Discord account to
enforcement under Discord's terms. It must remain opt-in and must never send a
message without a concrete user action.
