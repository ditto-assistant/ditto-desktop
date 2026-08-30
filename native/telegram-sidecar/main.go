package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gotd/contrib/middleware/floodwait"
	"github.com/gotd/contrib/middleware/ratelimit"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth/qrlogin"
	"github.com/gotd/td/telegram/message"
	"github.com/gotd/td/telegram/message/peer"
	"github.com/gotd/td/telegram/message/unpack"
	"github.com/gotd/td/telegram/query"
	"github.com/gotd/td/telegram/query/dialogs"
	querymessages "github.com/gotd/td/telegram/query/messages"
	"github.com/gotd/td/tg"
	"github.com/zalando/go-keyring"
	"golang.org/x/time/rate"
)

const (
	protocolVersion = 1
	keychainService = "ai.heyditto.telegram"
	keychainAccount = "default"
)

var (
	buildAPIID      string
	buildAPIHash    string
	errNotConnected = errors.New("telegram sidecar is not connected")
)

func protocolErrorCode(err error) string {
	if errors.Is(err, errNotConnected) {
		return "not_connected"
	}
	return "operation_failed"
}

type keychainSession struct{}

func (keychainSession) LoadSession(context.Context) ([]byte, error) {
	value, err := keyring.Get(keychainService, keychainAccount)
	if errors.Is(err, keyring.ErrNotFound) {
		return nil, session.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return []byte(value), nil
}

func (keychainSession) StoreSession(_ context.Context, data []byte) error {
	return keyring.Set(keychainService, keychainAccount, string(data))
}

type request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type protocolError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type response struct {
	ID     string         `json:"id,omitempty"`
	Result any            `json:"result,omitempty"`
	Error  *protocolError `json:"error,omitempty"`
	Event  string         `json:"event,omitempty"`
	Data   any            `json:"data,omitempty"`
}

type participant struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
	Handle      string `json:"handle,omitempty"`
	IsSelf      bool   `json:"isSelf,omitempty"`
}

type conversation struct {
	ID              string        `json:"id"`
	Title           string        `json:"title"`
	Kind            string        `json:"kind"`
	LatestMessageAt string        `json:"latestMessageAt,omitempty"`
	Participants    []participant `json:"participants"`
}

type chatMessage struct {
	ID          string       `json:"id"`
	ChannelID   string       `json:"channelId"`
	Content     string       `json:"content"`
	Timestamp   string       `json:"timestamp"`
	Author      participant  `json:"author"`
	ReplyToID   string       `json:"replyToId,omitempty"`
	Attachments []attachment `json:"attachments"`
}

type attachment struct {
	ID       string `json:"id"`
	Filename string `json:"filename,omitempty"`
	Size     int64  `json:"size,omitempty"`
}

type status struct {
	ProtocolVersion int          `json:"protocolVersion"`
	Configured      bool         `json:"configured"`
	Connected       bool         `json:"connected"`
	LoginPending    bool         `json:"loginPending"`
	Detail          string       `json:"detail"`
	User            *participant `json:"user,omitempty"`
}

type peerRecord struct {
	peer     tg.InputPeerClass
	title    string
	kind     string
	entities peer.Entities
}

type server struct {
	mu           sync.RWMutex
	writeMu      sync.Mutex
	client       *telegram.Client
	api          *tg.Client
	loggedIn     qrlogin.LoggedIn
	self         *tg.User
	connected    bool
	loginPending bool
	lastError    string
	peers        map[string]peerRecord
	receipts     map[string]chatMessage
	cancel       context.CancelFunc
	ready        chan struct{}
}

func credentials() (int, string, bool) {
	idValue := strings.TrimSpace(os.Getenv("DITTO_TELEGRAM_API_ID"))
	if idValue == "" {
		idValue = strings.TrimSpace(buildAPIID)
	}
	hash := strings.TrimSpace(os.Getenv("DITTO_TELEGRAM_API_HASH"))
	if hash == "" {
		hash = strings.TrimSpace(buildAPIHash)
	}
	id, err := strconv.Atoi(idValue)
	return id, hash, err == nil && id > 0 && hash != ""
}

func newServer() *server {
	return &server{peers: make(map[string]peerRecord), receipts: make(map[string]chatMessage)}
}

func (s *server) ensureClient() error {
	s.mu.Lock()
	if s.client != nil {
		ready := s.ready
		s.mu.Unlock()
		select {
		case <-ready:
			return nil
		case <-time.After(20 * time.Second):
			return errors.New("Telegram connection timed out")
		}
	}
	apiID, apiHash, ok := credentials()
	if !ok {
		s.mu.Unlock()
		return errors.New("Telegram is not configured in this build")
	}
	dispatcher := tg.NewUpdateDispatcher()
	loggedIn := qrlogin.OnLoginToken(dispatcher)
	client := telegram.NewClient(apiID, apiHash, telegram.Options{
		SessionStorage: keychainSession{},
		UpdateHandler:  dispatcher,
		Device:         telegram.DeviceConfig{DeviceModel: "Ditto Desktop"},
		Middlewares: []telegram.Middleware{
			floodwait.NewSimpleWaiter(),
			ratelimit.New(rate.Every(100*time.Millisecond), 5),
		},
	})
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan struct{})
	s.client = client
	s.loggedIn = loggedIn
	s.ready = ready
	s.cancel = cancel
	s.mu.Unlock()

	go func() {
		err := client.Run(ctx, func(ctx context.Context) error {
			s.mu.Lock()
			s.api = client.API()
			close(ready)
			s.mu.Unlock()
			if authStatus, statusErr := client.Auth().Status(ctx); statusErr == nil && authStatus.Authorized {
				s.markAuthorized(ctx)
			}
			<-ctx.Done()
			return ctx.Err()
		})
		s.mu.Lock()
		s.client = nil
		s.api = nil
		s.connected = false
		if err != nil && !errors.Is(err, context.Canceled) {
			s.lastError = err.Error()
		}
		s.mu.Unlock()
	}()
	select {
	case <-ready:
		return nil
	case <-time.After(20 * time.Second):
		cancel()
		return errors.New("Telegram connection timed out")
	}
}

func (s *server) markAuthorized(ctx context.Context) {
	s.mu.RLock()
	client := s.client
	s.mu.RUnlock()
	if client == nil {
		return
	}
	self, err := client.Self(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err == nil {
		s.self = self
	}
	s.connected = err == nil
	s.loginPending = false
	s.lastError = ""
}

func (s *server) currentStatus() status {
	_, _, configured := credentials()
	s.mu.RLock()
	defer s.mu.RUnlock()
	detail := "Connect Telegram to enable local chats and replies."
	if !configured {
		detail = "This build needs Ditto's Telegram app credentials."
	} else if s.connected {
		detail = "Connected directly to Telegram on this device."
	} else if s.loginPending {
		detail = "Approve this sign-in from Telegram on another device."
	} else if s.lastError != "" {
		detail = s.lastError
	}
	result := status{ProtocolVersion: protocolVersion, Configured: configured, Connected: s.connected, LoginPending: s.loginPending, Detail: detail}
	if s.self != nil {
		p := userParticipant(s.self, true)
		result.User = &p
	}
	return result
}

func (s *server) restore() (status, error) {
	if err := s.ensureClient(); err != nil {
		return s.currentStatus(), err
	}
	s.mu.RLock()
	client := s.client
	s.mu.RUnlock()
	if client == nil {
		return s.currentStatus(), errors.New("Telegram client unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	authStatus, err := client.Auth().Status(ctx)
	if err != nil {
		return s.currentStatus(), err
	}
	if authStatus.Authorized {
		s.markAuthorized(ctx)
	}
	return s.currentStatus(), nil
}

func (s *server) startLogin() (any, error) {
	if restored, err := s.restore(); err == nil && restored.Connected {
		return map[string]any{"connected": true, "status": restored}, nil
	}
	s.mu.Lock()
	if s.loginPending {
		s.mu.Unlock()
		return nil, errors.New("Telegram sign-in is already pending")
	}
	client := s.client
	s.loginPending = true
	s.mu.Unlock()
	if client == nil {
		return nil, errors.New("Telegram client unavailable")
	}
	tokens := make(chan qrlogin.Token, 1)
	// Auth receives login-token updates through the client's handler and also
	// refreshes expired codes. The first token is returned immediately; later
	// tokens are emitted so the renderer can replace an expired QR.
	s.mu.RLock()
	loggedIn := s.loggedIn
	s.mu.RUnlock()
	ctx := context.Background()
	go func() {
		_, err := client.QR().Auth(ctx, loggedIn, func(_ context.Context, token qrlogin.Token) error {
			select {
			case tokens <- token:
			default:
				s.emit("login.qr", map[string]any{"qrUrl": token.URL(), "expiresAt": token.Expires().UTC().Format(time.RFC3339)})
			}
			return nil
		})
		if err == nil {
			s.markAuthorized(context.Background())
			s.emit("connection.status", s.currentStatus())
		} else {
			s.mu.Lock()
			s.loginPending = false
			s.lastError = err.Error()
			s.mu.Unlock()
			s.emit("connection.status", s.currentStatus())
		}
	}()
	select {
	case token := <-tokens:
		return map[string]any{"connected": false, "qrUrl": token.URL(), "expiresInSeconds": max(1, int(time.Until(token.Expires()).Seconds()))}, nil
	case <-time.After(20 * time.Second):
		s.mu.Lock()
		s.loginPending = false
		s.mu.Unlock()
		return nil, errors.New("Telegram did not issue a QR code")
	}
}

func (s *server) requireConnected() (*tg.Client, *tg.User, error) {
	st, err := s.restore()
	if err != nil || !st.Connected {
		return nil, nil, errNotConnected
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.api, s.self, nil
}

func (s *server) listConversations() ([]conversation, error) {
	api, self, err := s.requireConnected()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result := make([]conversation, 0, 100)
	peers := make(map[string]peerRecord)
	errStop := errors.New("dialog limit")
	err = query.GetDialogs(api).ForEach(ctx, func(_ context.Context, elem dialogs.Elem) error {
		if elem.Deleted() {
			return nil
		}
		if len(result) >= 200 {
			return errStop
		}
		id, title, kind, participants := describeDialog(elem, self)
		if id == "" {
			return nil
		}
		item := conversation{ID: id, Title: title, Kind: kind, Participants: participants}
		if elem.Last != nil {
			item.LatestMessageAt = time.Unix(int64(elem.Last.GetDate()), 0).UTC().Format(time.RFC3339)
		}
		result = append(result, item)
		peers[id] = peerRecord{peer: elem.Peer, title: title, kind: kind, entities: elem.Entities}
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return nil, err
	}
	s.mu.Lock()
	s.peers = peers
	s.mu.Unlock()
	sort.SliceStable(result, func(i, j int) bool { return result[i].LatestMessageAt > result[j].LatestMessageAt })
	return result, nil
}

func (s *server) resolvePeer(id string) (peerRecord, error) {
	s.mu.RLock()
	record, ok := s.peers[id]
	s.mu.RUnlock()
	if ok {
		return record, nil
	}
	if _, err := s.listConversations(); err != nil {
		return peerRecord{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	record, ok = s.peers[id]
	if !ok {
		return peerRecord{}, errors.New("Telegram conversation not found")
	}
	return record, nil
}

func (s *server) listMessages(channelID string, limit int) ([]chatMessage, error) {
	api, self, err := s.requireConnected()
	if err != nil {
		return nil, err
	}
	record, err := s.resolvePeer(channelID)
	if err != nil {
		return nil, err
	}
	limit = min(max(limit, 1), 500)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result := make([]chatMessage, 0, limit)
	errStop := errors.New("message limit")
	err = query.Messages(api).GetHistory(record.peer).BatchSize(min(limit, 100)).ForEach(ctx, func(_ context.Context, elem querymessages.Elem) error {
		if len(result) >= limit {
			return errStop
		}
		msg, ok := elem.Msg.(*tg.Message)
		if !ok {
			return nil
		}
		result = append(result, normalizeMessage(channelID, msg, elem.Entities, self, record.title))
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return nil, err
	}
	for i, j := 0, len(result)-1; i < j; i, j = i+1, j-1 {
		result[i], result[j] = result[j], result[i]
	}
	return result, nil
}

func (s *server) sendMessage(channelID, content, idempotencyKey string) (chatMessage, error) {
	api, self, err := s.requireConnected()
	if err != nil {
		return chatMessage{}, err
	}
	if strings.TrimSpace(content) == "" {
		return chatMessage{}, errors.New("message text is required")
	}
	s.mu.RLock()
	if receipt, ok := s.receipts[idempotencyKey]; ok {
		s.mu.RUnlock()
		return receipt, nil
	}
	s.mu.RUnlock()
	record, err := s.resolvePeer(channelID)
	if err != nil {
		return chatMessage{}, err
	}
	hash := sha256.Sum256([]byte(idempotencyKey))
	randomID := int64(binary.LittleEndian.Uint64(hash[:8]))
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	msg, err := unpack.Message(message.NewSender(api).To(record.peer).RandomID(randomID).Text(ctx, content))
	if err != nil {
		return chatMessage{}, err
	}
	receipt := normalizeMessage(channelID, msg, record.entities, self, record.title)
	s.mu.Lock()
	s.receipts[idempotencyKey] = receipt
	s.mu.Unlock()
	return receipt, nil
}

func describeDialog(elem dialogs.Elem, self *tg.User) (string, string, string, []participant) {
	d, ok := elem.Dialog.(*tg.Dialog)
	if !ok {
		return "", "", "", nil
	}
	selfParticipant := userParticipant(self, true)
	switch p := d.Peer.(type) {
	case *tg.PeerUser:
		u, ok := elem.Entities.User(p.UserID)
		if !ok {
			return "user:" + strconv.FormatInt(p.UserID, 10), "Telegram user", "direct", []participant{selfParticipant}
		}
		return "user:" + strconv.FormatInt(p.UserID, 10), userName(u), "direct", []participant{selfParticipant, userParticipant(u, false)}
	case *tg.PeerChat:
		if chat, ok := elem.Entities.Chat(p.ChatID); ok {
			return "chat:" + strconv.FormatInt(p.ChatID, 10), chat.Title, "group", []participant{selfParticipant}
		}
	case *tg.PeerChannel:
		if channel, ok := elem.Entities.Channel(p.ChannelID); ok {
			kind := "channel"
			if channel.Megagroup {
				kind = "group"
			}
			return "channel:" + strconv.FormatInt(p.ChannelID, 10), channel.Title, kind, []participant{selfParticipant}
		}
	}
	return "", "", "", nil
}

func normalizeMessage(channelID string, msg *tg.Message, entities peer.Entities, self *tg.User, fallback string) chatMessage {
	author := participant{ID: "unknown", DisplayName: fallback}
	if msg.Out && self != nil {
		author = userParticipant(self, true)
	} else {
		from := msg.FromID
		if from == nil {
			from = msg.PeerID
		}
		if userPeer, ok := from.(*tg.PeerUser); ok {
			if user, found := entities.User(userPeer.UserID); found {
				author = userParticipant(user, false)
			} else {
				author.ID = strconv.FormatInt(userPeer.UserID, 10)
			}
		}
	}
	result := chatMessage{
		ID: strconv.Itoa(msg.ID), ChannelID: channelID, Content: msg.Message,
		Timestamp: time.Unix(int64(msg.Date), 0).UTC().Format(time.RFC3339),
		Author:    author, Attachments: []attachment{},
	}
	if reply, ok := msg.ReplyTo.(*tg.MessageReplyHeader); ok && reply.ReplyToMsgID != 0 {
		result.ReplyToID = strconv.Itoa(reply.ReplyToMsgID)
	}
	if msg.Media != nil {
		result.Attachments = append(result.Attachments, attachment{ID: "media:" + strconv.Itoa(msg.ID), Filename: mediaLabel(msg.Media)})
	}
	return result
}

func mediaLabel(media tg.MessageMediaClass) string {
	switch media.(type) {
	case *tg.MessageMediaPhoto:
		return "Photo"
	case *tg.MessageMediaDocument:
		return "Attachment"
	default:
		return "Telegram media"
	}
}

func userParticipant(user *tg.User, self bool) participant {
	if user == nil {
		return participant{ID: "self", DisplayName: "Me", IsSelf: self}
	}
	result := participant{ID: strconv.FormatInt(user.ID, 10), DisplayName: userName(user), IsSelf: self}
	if user.Username != "" {
		result.Handle = "@" + user.Username
	}
	return result
}

func userName(user *tg.User) string {
	if name := strings.TrimSpace(user.FirstName + " " + user.LastName); name != "" {
		return name
	}
	if user.Username != "" {
		return "@" + user.Username
	}
	return "Telegram user"
}

func (s *server) emit(event string, data any) {
	s.write(response{Event: event, Data: data})
}

func (s *server) write(value response) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(value)
}

func (s *server) handle(req request) (any, error) {
	switch req.Method {
	case "status":
		return s.currentStatus(), nil
	case "connection.restore":
		return s.restore()
	case "login.start":
		return s.startLogin()
	case "logout":
		s.mu.Lock()
		cancel := s.cancel
		s.cancel = nil
		s.connected = false
		s.self = nil
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		if err := keyring.Delete(keychainService, keychainAccount); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return nil, err
		}
		return s.currentStatus(), nil
	case "conversations.list":
		return s.listConversations()
	case "messages.list":
		var params struct {
			ChannelID string `json:"channelId"`
			Limit     int    `json:"limit"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, err
		}
		return s.listMessages(params.ChannelID, params.Limit)
	case "message.send":
		var params struct {
			ChannelID      string `json:"channelId"`
			Content        string `json:"content"`
			IdempotencyKey string `json:"idempotencyKey"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, err
		}
		return s.sendMessage(params.ChannelID, params.Content, params.IdempotencyKey)
	default:
		return nil, fmt.Errorf("unknown method %q", req.Method)
	}
}

func main() {
	_ = flag.String("state-dir", "", "reserved for local state")
	flag.Parse()
	s := newServer()
	var requests sync.WaitGroup
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			continue
		}
		requests.Add(1)
		go func() {
			defer requests.Done()
			result, err := s.handle(req)
			if err != nil {
				s.write(response{ID: req.ID, Error: &protocolError{Code: protocolErrorCode(err), Message: err.Error()}})
				return
			}
			s.write(response{ID: req.ID, Result: result})
		}()
	}
	requests.Wait()
	s.mu.RLock()
	cancel := s.cancel
	s.mu.RUnlock()
	if cancel != nil {
		cancel()
	}
}
