// SPDX-License-Identifier: AGPL-3.0-only
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/zalando/go-keyring"
)

const (
	protocolVersion = 1
	keyringService  = "ai.heyditto.discord"
	keyringAccount  = "default"
)

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type protocolError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type response struct {
	ID     string         `json:"id"`
	Result any            `json:"result,omitempty"`
	Error  *protocolError `json:"error,omitempty"`
}

type event struct {
	Event string `json:"event"`
	Data  any    `json:"data,omitempty"`
}

type output struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

func (o *output) write(value any) {
	o.mu.Lock()
	defer o.mu.Unlock()
	_ = o.encoder.Encode(value)
}

type sidecar struct {
	ctx            context.Context
	out            *output
	mu             sync.RWMutex
	session        *discordgo.Session
	self           *discordgo.User
	loginStop      context.CancelFunc
	authGeneration uint64
	sendMu         sync.Mutex
	receipts       map[string]sendReceipt
	receiptPath    string
}

type sendReceipt struct {
	ChannelID string `json:"channelId"`
	MessageID string `json:"messageId"`
}

type statusResult struct {
	ProtocolVersion int              `json:"protocolVersion"`
	Connected       bool             `json:"connected"`
	LoginPending    bool             `json:"loginPending"`
	User            *wireParticipant `json:"user,omitempty"`
	Detail          string           `json:"detail"`
}

type wireParticipant struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Handle      string `json:"handle,omitempty"`
	AvatarURL   string `json:"avatarUrl,omitempty"`
	IsSelf      bool   `json:"isSelf,omitempty"`
	IsBot       bool   `json:"isBot,omitempty"`
}

type wireConversation struct {
	ID              string            `json:"id"`
	Title           string            `json:"title"`
	Kind            string            `json:"kind"`
	GuildID         string            `json:"guildId,omitempty"`
	GuildName       string            `json:"guildName,omitempty"`
	GuildAvatarURL  string            `json:"guildAvatarUrl,omitempty"`
	ParentID        string            `json:"parentId,omitempty"`
	Position        int               `json:"position,omitempty"`
	LastMessageID   string            `json:"lastMessageId,omitempty"`
	LatestMessageAt string            `json:"latestMessageAt,omitempty"`
	Participants    []wireParticipant `json:"participants,omitempty"`
}

type wireAttachment struct {
	ID          string `json:"id"`
	Filename    string `json:"filename,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	Size        int    `json:"size,omitempty"`
	URL         string `json:"url,omitempty"`
	ProxyURL    string `json:"proxyUrl,omitempty"`
}

type wireMessage struct {
	ID          string           `json:"id"`
	ChannelID   string           `json:"channelId"`
	GuildID     string           `json:"guildId,omitempty"`
	Content     string           `json:"content"`
	Timestamp   string           `json:"timestamp"`
	EditedAt    string           `json:"editedAt,omitempty"`
	Author      wireParticipant  `json:"author"`
	Attachments []wireAttachment `json:"attachments"`
	ReplyToID   string           `json:"replyToId,omitempty"`
	Nonce       string           `json:"nonce,omitempty"`
}

func main() {
	stateDir := flag.String("state-dir", "", "local directory for non-secret delivery receipts")
	flag.Parse()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	out := &output{encoder: json.NewEncoder(os.Stdout)}
	app := &sidecar{ctx: ctx, out: out, receipts: make(map[string]sendReceipt)}
	if *stateDir != "" {
		app.receiptPath = filepath.Join(*stateDir, "discord-send-receipts.json")
		app.loadReceipts()
	}
	go app.restore()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	var requests sync.WaitGroup
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			out.write(response{Error: &protocolError{Code: "invalid_request", Message: "Invalid JSON request."}})
			continue
		}
		requests.Add(1)
		go func() {
			defer requests.Done()
			app.handle(req)
		}()
	}
	requests.Wait()
	app.closeSession()
}

func (s *sidecar) handle(req request) {
	result, err := s.dispatch(req.Method, req.Params)
	if err != nil {
		s.out.write(response{ID: req.ID, Error: &protocolError{Code: errorCode(err), Message: err.Error()}})
		return
	}
	s.out.write(response{ID: req.ID, Result: result})
}

func (s *sidecar) dispatch(method string, params json.RawMessage) (any, error) {
	switch method {
	case "status":
		return s.status(), nil
	case "login.start":
		return s.startLogin()
	case "login.cancel":
		s.mu.Lock()
		s.authGeneration++
		if s.loginStop != nil {
			s.loginStop()
			s.loginStop = nil
		}
		s.mu.Unlock()
		return map[string]bool{"cancelled": true}, nil
	case "logout":
		s.closeSession()
		if err := keyring.Delete(keyringService, keyringAccount); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return nil, fmt.Errorf("remove Discord credential: %w", err)
		}
		return map[string]bool{"loggedOut": true}, nil
	case "conversations.list":
		return s.listConversations()
	case "messages.list":
		var input struct {
			ChannelID string `json:"channelId"`
			Limit     int    `json:"limit"`
			BeforeID  string `json:"beforeId,omitempty"`
		}
		if err := json.Unmarshal(params, &input); err != nil || input.ChannelID == "" {
			return nil, errors.New("channelId is required")
		}
		return s.listMessages(input.ChannelID, input.Limit, input.BeforeID)
	case "message.send":
		var input struct {
			ChannelID       string   `json:"channelId"`
			GuildID         string   `json:"guildId,omitempty"`
			Content         string   `json:"content"`
			ReplyToID       string   `json:"replyToId,omitempty"`
			AttachmentPaths []string `json:"attachmentPaths,omitempty"`
			IdempotencyKey  string   `json:"idempotencyKey"`
		}
		if err := json.Unmarshal(params, &input); err != nil || input.ChannelID == "" || input.IdempotencyKey == "" {
			return nil, errors.New("channelId and idempotencyKey are required")
		}
		if strings.TrimSpace(input.Content) == "" && len(input.AttachmentPaths) == 0 {
			return nil, errors.New("message content or an attachment is required")
		}
		return s.sendMessage(input.ChannelID, input.GuildID, input.Content, input.ReplyToID, input.IdempotencyKey, input.AttachmentPaths)
	default:
		return nil, fmt.Errorf("unsupported method %q", method)
	}
}

func (s *sidecar) status() statusResult {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := statusResult{ProtocolVersion: protocolVersion, Connected: s.session != nil, LoginPending: s.loginStop != nil}
	if s.self != nil {
		participant := participantFromUser(s.self, true)
		result.User = &participant
	}
	if result.Connected {
		result.Detail = "Connected directly to Discord on this device."
	} else if result.LoginPending {
		result.Detail = "Waiting for Discord login approval."
	} else {
		result.Detail = "Connect Discord to enable live messages and replies."
	}
	return result
}

func (s *sidecar) restore() {
	s.mu.RLock()
	generation := s.authGeneration
	s.mu.RUnlock()
	token, err := keyring.Get(keyringService, keyringAccount)
	if err != nil {
		if !errors.Is(err, keyring.ErrNotFound) {
			s.out.write(event{Event: "connection.error", Data: map[string]string{"message": "Could not read the saved Discord credential."}})
		}
		return
	}
	if err := s.connect(token, generation); err != nil && !errors.Is(err, context.Canceled) {
		s.out.write(event{Event: "connection.error", Data: map[string]string{"message": err.Error()}})
	}
}

func (s *sidecar) startLogin() (any, error) {
	s.mu.Lock()
	if s.loginStop != nil {
		s.mu.Unlock()
		return nil, errors.New("a Discord login is already pending")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 3*time.Minute)
	s.authGeneration++
	generation := s.authGeneration
	s.loginStop = cancel
	s.mu.Unlock()

	client, err := newRemoteAuthClient()
	if err != nil {
		cancel()
		s.clearPendingLogin(generation)
		return nil, err
	}
	qr, result, err := client.start(ctx)
	if err != nil {
		cancel()
		s.clearPendingLogin(generation)
		return nil, err
	}

	select {
	case qrURL, ok := <-qr:
		if !ok || qrURL == "" {
			cancel()
			s.clearPendingLogin(generation)
			return nil, errors.New("Discord did not return a login QR code")
		}
		go s.finishLogin(generation, cancel, result)
		return map[string]any{"qrUrl": qrURL, "expiresInSeconds": 180}, nil
	case <-time.After(15 * time.Second):
		cancel()
		s.clearPendingLogin(generation)
		return nil, errors.New("timed out waiting for Discord login QR code")
	case <-s.ctx.Done():
		cancel()
		s.clearPendingLogin(generation)
		return nil, s.ctx.Err()
	}
}

func (s *sidecar) finishLogin(generation uint64, cancel context.CancelFunc, results <-chan remoteAuthResult) {
	result, ok := <-results
	cancel()
	s.clearPendingLogin(generation)
	if !ok || result.err != nil {
		message := "Discord login ended before approval."
		if result.err != nil && !errors.Is(result.err, context.Canceled) {
			message = result.err.Error()
		}
		s.out.write(event{Event: "login.failed", Data: map[string]string{"message": message}})
		return
	}
	s.mu.RLock()
	current := s.authGeneration == generation
	s.mu.RUnlock()
	if !current {
		return
	}
	if err := keyring.Set(keyringService, keyringAccount, result.user.Token); err != nil {
		s.out.write(event{Event: "login.failed", Data: map[string]string{"message": "Could not save the Discord credential in the system credential store."}})
		return
	}
	if err := s.connect(result.user.Token, generation); err != nil {
		s.out.write(event{Event: "login.failed", Data: map[string]string{"message": err.Error()}})
		return
	}
	s.out.write(event{Event: "login.completed", Data: s.status()})
}

func (s *sidecar) clearPendingLogin(generation uint64) {
	s.mu.Lock()
	if s.authGeneration == generation {
		s.loginStop = nil
	}
	s.mu.Unlock()
}

func (s *sidecar) connect(token string, generation uint64) error {
	session, err := discordgo.New(token)
	if err != nil {
		return fmt.Errorf("create Discord session: %w", err)
	}
	if err := session.LoadMainPage(s.ctx); err != nil {
		return fmt.Errorf("load Discord client metadata: %w", err)
	}
	session.AddHandler(func(_ *discordgo.Session, message *discordgo.MessageCreate) {
		s.out.write(event{Event: "message.created", Data: s.message(message.Message)})
	})
	session.AddHandler(func(_ *discordgo.Session, message *discordgo.MessageUpdate) {
		s.out.write(event{Event: "message.updated", Data: s.message(message.Message)})
	})
	session.AddHandler(func(_ *discordgo.Session, message *discordgo.MessageDelete) {
		s.out.write(event{Event: "message.deleted", Data: map[string]string{"id": message.ID, "channelId": message.ChannelID, "guildId": message.GuildID}})
	})
	if err := session.Open(); err != nil {
		return fmt.Errorf("open Discord gateway: %w", err)
	}
	self, err := session.User("@me")
	if err != nil {
		_ = session.Close()
		return fmt.Errorf("load Discord identity: %w", err)
	}

	s.mu.Lock()
	if s.authGeneration != generation {
		s.mu.Unlock()
		_ = session.Close()
		return context.Canceled
	}
	previous := s.session
	s.session = session
	s.self = self
	s.mu.Unlock()
	if previous != nil {
		_ = previous.Close()
	}
	s.out.write(event{Event: "connection.ready", Data: s.status()})
	return nil
}

func (s *sidecar) closeSession() {
	s.mu.Lock()
	s.authGeneration++
	session := s.session
	s.session = nil
	s.self = nil
	if s.loginStop != nil {
		s.loginStop()
		s.loginStop = nil
	}
	s.mu.Unlock()
	if session != nil {
		_ = session.Close()
	}
}

func (s *sidecar) currentSession() (*discordgo.Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.session == nil {
		return nil, errors.New("Discord is not connected")
	}
	return s.session, nil
}

func (s *sidecar) listConversations() ([]wireConversation, error) {
	session, err := s.currentSession()
	if err != nil {
		return nil, err
	}
	privateChannels, err := session.UserChannels()
	if err != nil {
		return nil, fmt.Errorf("list Discord direct messages: %w", err)
	}
	conversations := make([]wireConversation, 0, len(privateChannels))
	for _, channel := range privateChannels {
		conversations = append(conversations, conversationFromChannel(channel, "", "", ""))
	}

	guilds, err := session.UserGuilds(200, "", "", false)
	if err != nil {
		return nil, fmt.Errorf("list Discord servers: %w", err)
	}
	for _, guild := range guilds {
		channels, channelErr := session.GuildChannels(guild.ID)
		if channelErr != nil {
			continue
		}
		for _, channel := range channels {
			if channel.Type != discordgo.ChannelTypeGuildText && channel.Type != discordgo.ChannelTypeGuildNews && channel.Type != discordgo.ChannelTypeGuildPublicThread && channel.Type != discordgo.ChannelTypeGuildPrivateThread && channel.Type != discordgo.ChannelTypeGuildNewsThread {
				continue
			}
			conversations = append(conversations, conversationFromChannel(channel, guild.ID, guild.Name, guildIconURL(guild)))
		}
	}
	sort.SliceStable(conversations, func(i, j int) bool {
		if conversations[i].GuildName == conversations[j].GuildName {
			return conversations[i].Position < conversations[j].Position
		}
		return conversations[i].GuildName < conversations[j].GuildName
	})
	return conversations, nil
}

func (s *sidecar) listMessages(channelID string, limit int, beforeID string) ([]wireMessage, error) {
	session, err := s.currentSession()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	} else if limit > 100 {
		limit = 100
	}
	messages, err := session.ChannelMessages(channelID, limit, beforeID, "", "")
	if err != nil {
		return nil, fmt.Errorf("list Discord messages: %w", err)
	}
	result := make([]wireMessage, 0, len(messages))
	for index := len(messages) - 1; index >= 0; index-- {
		result = append(result, s.message(messages[index]))
	}
	return result, nil
}

func (s *sidecar) sendMessage(channelID, guildID, content, replyToID, nonce string, paths []string) (wireMessage, error) {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()
	session, err := s.currentSession()
	if err != nil {
		return wireMessage{}, err
	}
	if receipt, ok := s.receipts[nonce]; ok {
		message, fetchErr := session.ChannelMessage(receipt.ChannelID, receipt.MessageID)
		if fetchErr == nil {
			return s.message(message), nil
		}
		return wireMessage{}, fmt.Errorf("verify previous Discord send receipt: %w", fetchErr)
	}
	channel, channelErr := session.Channel(channelID)
	if channelErr == nil && guildID == "" {
		guildID = channel.GuildID
	}
	options := []discordgo.RequestOption{}
	if channelErr == nil && channel.IsThread() && guildID != "" && channel.ParentID != "" {
		options = append(options, discordgo.WithThreadReferer(guildID, channel.ParentID, channelID))
	} else {
		options = append(options, discordgo.WithChannelReferer(guildID, channelID))
	}
	attachments, attachmentErr := prepareAttachments(session, channelID, paths, options)
	if attachmentErr != nil {
		return wireMessage{}, attachmentErr
	}
	payload := &discordgo.MessageSend{Content: content, Nonce: nonce, Attachments: attachments}
	if replyToID != "" {
		failIfMissing := false
		payload.Reference = &discordgo.MessageReference{MessageID: replyToID, ChannelID: channelID, GuildID: guildID, FailIfNotExists: &failIfMissing}
	}
	message, err := session.ChannelMessageSendComplex(channelID, payload, options...)
	if err != nil {
		return wireMessage{}, fmt.Errorf("send Discord message: %w", err)
	}
	if len(s.receipts) >= 1024 {
		for key := range s.receipts {
			delete(s.receipts, key)
			break
		}
	}
	s.receipts[nonce] = sendReceipt{ChannelID: message.ChannelID, MessageID: message.ID}
	if err := s.saveReceipts(); err != nil {
		s.out.write(event{Event: "receipt.persistence_failed", Data: map[string]string{"message": "The delivery receipt could not be saved across restarts."}})
	}
	return s.message(message), nil
}

func prepareAttachments(session *discordgo.Session, channelID string, paths []string, options []discordgo.RequestOption) ([]*discordgo.MessageAttachment, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	if len(paths) > 10 {
		return nil, errors.New("Discord messages support at most 10 attachments")
	}
	type localAttachment struct {
		data        []byte
		filename    string
		contentType string
	}
	local := make([]localAttachment, 0, len(paths))
	request := &discordgo.ReqPrepareAttachments{Files: make([]*discordgo.FilePrepare, 0, len(paths))}
	totalSize := 0
	for index, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("open attachment %q: %w", filepath.Base(path), err)
		}
		if len(data) > 25*1024*1024 {
			return nil, fmt.Errorf("attachment %q exceeds the 25 MB local safety limit", filepath.Base(path))
		}
		totalSize += len(data)
		if totalSize > 100*1024*1024 {
			return nil, errors.New("attachments exceed the 100 MB local safety limit")
		}
		contentType := mime.TypeByExtension(filepath.Ext(path))
		filename := filepath.Base(path)
		isClip := false
		local = append(local, localAttachment{data: data, filename: filename, contentType: contentType})
		request.Files = append(request.Files, &discordgo.FilePrepare{
			Size:                len(data),
			Name:                filename,
			ID:                  fmt.Sprintf("%d", index),
			IsClip:              &isClip,
			OriginalContentType: contentType,
		})
	}
	prepared, err := session.ChannelAttachmentCreate(channelID, request, options...)
	if err != nil {
		return nil, fmt.Errorf("prepare Discord attachments: %w", err)
	}
	if len(prepared.Attachments) != len(local) {
		return nil, errors.New("Discord returned an incomplete attachment upload plan")
	}
	result := make([]*discordgo.MessageAttachment, 0, len(local))
	for index, attachment := range local {
		remote := prepared.Attachments[index]
		if err := uploadAttachment(session.Client, remote.UploadURL, attachment.data); err != nil {
			return nil, fmt.Errorf("upload Discord attachment %q: %w", attachment.filename, err)
		}
		result = append(result, &discordgo.MessageAttachment{
			ID:                  fmt.Sprintf("%d", index),
			Filename:            attachment.filename,
			OriginalContentType: attachment.contentType,
			UploadedFilename:    remote.UploadFilename,
		})
	}
	return result, nil
}

func uploadAttachment(client *http.Client, url string, data []byte) error {
	request, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(data))
	if err != nil {
		return err
	}
	for key, value := range discordgo.DroidBaseHeaders {
		request.Header.Set(key, value)
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("Referer", "https://discord.com/")
	request.Header.Set("Sec-Fetch-Dest", "empty")
	request.Header.Set("Sec-Fetch-Mode", "cors")
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("upload returned HTTP %d", response.StatusCode)
	}
	return nil
}

func (s *sidecar) loadReceipts() {
	if s.receiptPath == "" {
		return
	}
	data, err := os.ReadFile(s.receiptPath)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, &s.receipts)
}

func (s *sidecar) saveReceipts() error {
	if s.receiptPath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.receiptPath), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(s.receipts)
	if err != nil {
		return err
	}
	temporary := s.receiptPath + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, s.receiptPath)
}

func (s *sidecar) message(message *discordgo.Message) wireMessage {
	if message == nil {
		return wireMessage{}
	}
	attachments := make([]wireAttachment, 0, len(message.Attachments))
	for _, attachment := range message.Attachments {
		attachments = append(attachments, wireAttachment{ID: attachment.ID, Filename: attachment.Filename, ContentType: attachment.ContentType, Size: attachment.Size, URL: attachment.URL, ProxyURL: attachment.ProxyURL})
	}
	result := wireMessage{ID: message.ID, ChannelID: message.ChannelID, GuildID: message.GuildID, Content: message.Content, Timestamp: message.Timestamp.UTC().Format(time.RFC3339Nano), Author: participantFromUser(message.Author, s.isSelf(message.Author)), Attachments: attachments, Nonce: string(message.Nonce)}
	if message.EditedTimestamp != nil {
		result.EditedAt = message.EditedTimestamp.UTC().Format(time.RFC3339Nano)
	}
	if message.MessageReference != nil {
		result.ReplyToID = message.MessageReference.MessageID
	}
	return result
}

func (s *sidecar) isSelf(user *discordgo.User) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return user != nil && s.self != nil && user.ID == s.self.ID
}

func participantFromUser(user *discordgo.User, self bool) wireParticipant {
	if user == nil {
		return wireParticipant{DisplayName: "Unknown"}
	}
	displayName := user.GlobalName
	if displayName == "" {
		displayName = user.Username
	}
	return wireParticipant{ID: user.ID, DisplayName: displayName, Handle: user.Username, AvatarURL: user.AvatarURL("128"), IsSelf: self, IsBot: user.Bot}
}

func conversationFromChannel(channel *discordgo.Channel, guildID, guildName, guildAvatar string) wireConversation {
	kind := "channel"
	title := channel.Name
	participants := make([]wireParticipant, 0, len(channel.Recipients))
	if channel.Type == discordgo.ChannelTypeDM || channel.Type == discordgo.ChannelTypeGroupDM {
		if channel.Type == discordgo.ChannelTypeDM {
			kind = "direct"
		} else {
			kind = "group"
		}
		for _, recipient := range channel.Recipients {
			participants = append(participants, participantFromUser(recipient, false))
		}
		if title == "" {
			names := make([]string, 0, len(participants))
			for _, participant := range participants {
				names = append(names, participant.DisplayName)
			}
			title = strings.Join(names, ", ")
		}
	} else if channel.IsThread() {
		kind = "thread"
	}
	return wireConversation{ID: channel.ID, Title: title, Kind: kind, GuildID: guildID, GuildName: guildName, GuildAvatarURL: guildAvatar, ParentID: channel.ParentID, Position: channel.Position, LastMessageID: channel.LastMessageID, LatestMessageAt: snowflakeTimestamp(channel.LastMessageID), Participants: participants}
}

func snowflakeTimestamp(id string) string {
	if id == "" {
		return ""
	}
	value, err := discordgo.SnowflakeTimestamp(id)
	if err != nil {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func guildIconURL(guild *discordgo.UserGuild) string {
	if guild == nil || guild.Icon == "" {
		return ""
	}
	endpoint := discordgo.EndpointGuildIcon(guild.ID, guild.Icon)
	if strings.HasPrefix(guild.Icon, "a_") {
		endpoint = discordgo.EndpointGuildIconAnimated(guild.ID, guild.Icon)
	}
	separator := "?"
	if strings.Contains(endpoint, "?") {
		separator = "&"
	}
	return endpoint + separator + "size=128"
}

func errorCode(err error) string {
	message := err.Error()
	switch {
	case strings.Contains(message, "not connected"):
		return "not_connected"
	case strings.Contains(message, "required"):
		return "invalid_request"
	case strings.Contains(message, "login"):
		return "login_failed"
	default:
		return "transport_failed"
	}
}
