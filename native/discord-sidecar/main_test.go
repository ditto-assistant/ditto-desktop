// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/bwmarrin/discordgo"
)

func TestStatusReportsRecoverableConnectionError(t *testing.T) {
	app := &sidecar{ctx: context.Background(), connectionErr: "Gateway connection was interrupted."}
	status := app.status()
	if status.Connected || status.LoginPending {
		t.Fatalf("unexpected connection state: %#v", status)
	}
	if status.Detail != "Gateway connection was interrupted." {
		t.Fatalf("unexpected status detail: %q", status.Detail)
	}
}

func TestConversationFromDirectMessage(t *testing.T) {
	channel := &discordgo.Channel{
		ID:            "123",
		Type:          discordgo.ChannelTypeDM,
		LastMessageID: "456",
		Recipients: []*discordgo.User{{
			ID:         "789",
			Username:   "liam",
			GlobalName: "Liam",
		}},
	}
	conversation := conversationFromChannel(channel, "", "", "")
	if conversation.Kind != "direct" || conversation.Title != "Liam" {
		t.Fatalf("unexpected conversation: %#v", conversation)
	}
	if len(conversation.Participants) != 1 || conversation.Participants[0].Handle != "liam" {
		t.Fatalf("unexpected participants: %#v", conversation.Participants)
	}
}

func TestConversationFromGuildThread(t *testing.T) {
	channel := &discordgo.Channel{
		ID:       "thread",
		Name:     "release",
		Type:     discordgo.ChannelTypeGuildPublicThread,
		ParentID: "parent",
		Position: 4,
	}
	conversation := conversationFromChannel(channel, "guild", "Ditto", "icon")
	if conversation.Kind != "thread" || conversation.GuildName != "Ditto" || conversation.ParentID != "parent" {
		t.Fatalf("unexpected thread: %#v", conversation)
	}
}

func TestParticipantPrefersGlobalName(t *testing.T) {
	participant := participantFromUser(&discordgo.User{
		ID:         "1",
		Username:   "peyton",
		GlobalName: "Peyton Spencer",
	}, true)
	if participant.DisplayName != "Peyton Spencer" || participant.Handle != "peyton" || !participant.IsSelf {
		t.Fatalf("unexpected participant: %#v", participant)
	}
}

func TestGuildIconURL(t *testing.T) {
	static := guildIconURL(&discordgo.UserGuild{ID: "1", Icon: "hash"})
	animated := guildIconURL(&discordgo.UserGuild{ID: "1", Icon: "a_hash"})
	if static != "https://cdn.discordapp.com/icons/1/hash.png?size=128" {
		t.Fatalf("unexpected static icon URL: %s", static)
	}
	if animated != "https://cdn.discordapp.com/icons/1/a_hash.webp?animated=true&size=128" {
		t.Fatalf("unexpected animated icon URL: %s", animated)
	}
}

func TestSnowflakeTimestamp(t *testing.T) {
	want := time.Date(2026, time.August, 29, 12, 30, 0, 0, time.UTC)
	milliseconds := want.UnixMilli() - 1420070400000
	id := strconv.FormatInt(milliseconds<<22, 10)
	if got := snowflakeTimestamp(id); got != want.Format(time.RFC3339Nano) {
		t.Fatalf("snowflakeTimestamp() = %q, want %q", got, want.Format(time.RFC3339Nano))
	}
}
