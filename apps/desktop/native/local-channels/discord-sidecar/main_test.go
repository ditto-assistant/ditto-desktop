// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bwmarrin/discordgo"
)

type directoryTransport func(*http.Request) (*http.Response, error)

func (f directoryTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestConversationDirectoryUsesGatewayStateAndFetchesOnlyMissingGuilds(t *testing.T) {
	session, err := discordgo.New("fixture")
	if err != nil {
		t.Fatal(err)
	}
	text := &discordgo.Channel{ID: "text", Name: "general", Type: discordgo.ChannelTypeGuildText, GuildID: "cached"}
	thread := &discordgo.Channel{ID: "thread", Name: "release", Type: discordgo.ChannelTypeGuildPublicThread, GuildID: "cached"}
	if err := session.State.GuildAdd(&discordgo.Guild{ID: "cached", Channels: []*discordgo.Channel{text, thread, {ID: "voice", Type: discordgo.ChannelTypeGuildVoice}}, Threads: []*discordgo.Channel{thread}}); err != nil {
		t.Fatal(err)
	}
	if err := session.State.GuildAdd(&discordgo.Guild{ID: "empty", Channels: []*discordgo.Channel{}}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	requests := make(map[string]int)
	session.Client = &http.Client{Transport: directoryTransport(func(request *http.Request) (*http.Response, error) {
		mu.Lock()
		requests[request.URL.Path]++
		mu.Unlock()
		body := "[]"
		switch {
		case strings.HasSuffix(request.URL.Path, "/users/@me/guilds"):
			body = `[{"id":"cached","name":"Cached server"},{"id":"empty","name":"Empty server"},{"id":"missing","name":"Missing server"}]`
		case strings.HasSuffix(request.URL.Path, "/users/@me/channels"):
			body = `[{"id":"dm","type":1,"recipients":[{"id":"user","username":"Liam"}]}]`
		case strings.HasSuffix(request.URL.Path, "/guilds/missing/channels"):
			body = `[{"id":"fallback","name":"fallback","type":0}]`
		default:
			t.Errorf("unexpected directory request: %s", request.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	})}
	app := &sidecar{session: session}
	rows, err := app.listConversations()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 4 {
		t.Fatalf("want DM, cached text, one thread, fallback; got %#v", rows)
	}
	seen := make(map[string]wireConversation)
	for _, row := range rows {
		seen[row.ID] = row
	}
	if seen["thread"].Kind != "thread" || seen["text"].GuildName != "Cached server" || seen["fallback"].Title != "fallback" {
		t.Fatalf("directory lost cached or fallback metadata: %#v", rows)
	}
	if len(requests) != 3 {
		t.Fatalf("cached guilds should not make REST channel requests: %#v", requests)
	}
	if err := session.State.ChannelAdd(&discordgo.Channel{ID: "text", Name: "renamed", Type: discordgo.ChannelTypeGuildText, GuildID: "cached"}); err != nil {
		t.Fatal(err)
	}
	rows, err = app.listConversations()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.ID == "text" && row.Title != "renamed" {
			t.Fatalf("gateway update was not reflected: %#v", row)
		}
	}
}

func TestUnavailableOrUnloadedGuildDoesNotSuppressRESTFallback(t *testing.T) {
	session, err := discordgo.New("fixture")
	if err != nil {
		t.Fatal(err)
	}
	for _, guild := range []*discordgo.Guild{
		{ID: "unavailable", Unavailable: true, Channels: []*discordgo.Channel{}},
		{ID: "unloaded"},
	} {
		if err := session.State.GuildAdd(guild); err != nil {
			t.Fatal(err)
		}
		if _, ok := cachedGuildConversations(session, &discordgo.UserGuild{ID: guild.ID}); ok {
			t.Fatalf("incomplete state treated as a loaded directory: %s", guild.ID)
		}
	}
}

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

func TestDiscordTransportNoncePreservesShortValues(t *testing.T) {
	const actionID = "action-123"
	if got := discordTransportNonce(actionID); got != actionID {
		t.Fatalf("discordTransportNonce() = %q, want %q", got, actionID)
	}
}

func TestDiscordTransportNonceCompactsLongActionIDsDeterministically(t *testing.T) {
	const actionID = "616c3753-5711-423d-bfc2-3a9a211b6bf6"
	first := discordTransportNonce(actionID)
	second := discordTransportNonce(actionID)
	if first != second {
		t.Fatalf("discordTransportNonce() was not deterministic: %q != %q", first, second)
	}
	if len(first) > 25 {
		t.Fatalf("discordTransportNonce() length = %d, want <= 25", len(first))
	}
	if first == actionID {
		t.Fatal("discordTransportNonce() did not compact the long action ID")
	}
	if first == discordTransportNonce("716c3753-5711-423d-bfc2-3a9a211b6bf6") {
		t.Fatal("discordTransportNonce() collided for different action IDs")
	}
}

func TestSupersededLoginFailureDoesNotOverwriteNewAttempt(t *testing.T) {
	for _, failure := range []error{context.Canceled, context.DeadlineExceeded, errors.New("old callback failed"), nil} {
		t.Run(fmt.Sprint(failure), func(t *testing.T) {
			var encoded bytes.Buffer
			app := &sidecar{out: &output{encoder: json.NewEncoder(&encoded)}, authGeneration: 2, loginStop: func() {}, connectionErr: "New attempt status"}
			results := make(chan remoteAuthResult, 1)
			if failure != nil {
				results <- remoteAuthResult{err: failure}
			}
			close(results)
			cancelled := false
			app.finishLogin(1, func() { cancelled = true }, results)
			if !cancelled {
				t.Fatal("old remote-auth resources were not cancelled")
			}
			if app.connectionErr != "New attempt status" || app.loginStop == nil {
				t.Fatalf("stale callback changed the new login: detail=%q pending=%v", app.connectionErr, app.loginStop != nil)
			}
			if encoded.Len() != 0 {
				t.Fatalf("stale callback emitted an event: %s", encoded.String())
			}
		})
	}
}

func TestCurrentLoginFailureStillReportsItsStatus(t *testing.T) {
	var encoded bytes.Buffer
	app := &sidecar{out: &output{encoder: json.NewEncoder(&encoded)}, authGeneration: 1, loginStop: func() {}}
	results := make(chan remoteAuthResult, 1)
	results <- remoteAuthResult{err: context.DeadlineExceeded}
	close(results)
	app.finishLogin(1, func() {}, results)
	if app.loginStop != nil || app.connectionErr != "QR code expired. Connect again for a new code." {
		t.Fatalf("current failure did not settle login: %#v", app.status())
	}
	var result event
	if err := json.Unmarshal(encoded.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Event != "login.failed" {
		t.Fatalf("wrong login event: %#v", result)
	}
}
