module github.com/ditto-assistant/ditto-discord-sidecar

go 1.25.0

require (
	github.com/bwmarrin/discordgo v0.27.0
	github.com/gorilla/websocket v1.5.3
	github.com/zalando/go-keyring v0.2.8
)

require (
	github.com/coder/websocket v1.8.14 // indirect
	github.com/danieljoos/wincred v1.2.3 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/google/uuid v1.6.0 // indirect
	golang.org/x/sys v0.27.0 // indirect
)

replace github.com/bwmarrin/discordgo => github.com/beeper/discordgo v0.0.0-20260808090638-8051e14a4471
