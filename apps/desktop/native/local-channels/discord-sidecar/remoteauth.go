// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from mautrix-discord/remoteauth. See NOTICE.md.
package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/gorilla/websocket"
)

const remoteAuthURL = "wss://remote-auth-gateway.discord.gg/?v=2"

type remoteAuthUser struct {
	ID            string `json:"id"`
	Username      string `json:"username"`
	Discriminator string `json:"discriminator,omitempty"`
	AvatarHash    string `json:"avatarHash,omitempty"`
	Token         string `json:"-"`
}

type remoteAuthResult struct {
	user remoteAuthUser
	err  error
}

type remoteAuthClient struct {
	privateKey *rsa.PrivateKey
	conn       *websocket.Conn
	writes     sync.Mutex
}

func newRemoteAuthClient() (*remoteAuthClient, error) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generate remote-auth key: %w", err)
	}
	return &remoteAuthClient{privateKey: privateKey}, nil
}

func (c *remoteAuthClient) start(ctx context.Context) (<-chan string, <-chan remoteAuthResult, error) {
	header := http.Header{}
	for key, value := range discordgo.DroidWSHeaders {
		header.Set(key, value)
	}
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, remoteAuthURL, header)
	if err != nil {
		return nil, nil, fmt.Errorf("connect remote auth: %w", err)
	}
	c.conn = conn
	qr := make(chan string, 1)
	result := make(chan remoteAuthResult, 1)
	go c.run(ctx, qr, result)
	return qr, result, nil
}

func (c *remoteAuthClient) run(ctx context.Context, qr chan<- string, result chan<- remoteAuthResult) {
	defer close(qr)
	defer close(result)
	defer c.conn.Close()

	finish := func(user remoteAuthUser, err error) {
		select {
		case result <- remoteAuthResult{user: user, err: err}:
		case <-ctx.Done():
		}
	}

	var user remoteAuthUser
	var heartbeatCancel context.CancelFunc
	defer func() {
		if heartbeatCancel != nil {
			heartbeatCancel()
		}
	}()

	for {
		if err := c.conn.SetReadDeadline(time.Now().Add(3 * time.Minute)); err != nil {
			finish(user, err)
			return
		}
		_, payload, err := c.conn.ReadMessage()
		if err != nil {
			if ctx.Err() != nil {
				finish(user, ctx.Err())
			} else {
				finish(user, fmt.Errorf("read remote auth: %w", err))
			}
			return
		}

		var packet struct {
			OP                   string `json:"op"`
			TimeoutMS            int    `json:"timeout_ms"`
			HeartbeatInterval    int    `json:"heartbeat_interval"`
			EncryptedNonce       string `json:"encrypted_nonce"`
			Fingerprint          string `json:"fingerprint"`
			EncryptedUserPayload string `json:"encrypted_user_payload"`
			Ticket               string `json:"ticket"`
		}
		if err := json.Unmarshal(payload, &packet); err != nil {
			finish(user, fmt.Errorf("decode remote-auth packet: %w", err))
			return
		}

		switch packet.OP {
		case "hello":
			if packet.HeartbeatInterval <= 0 || packet.TimeoutMS <= 0 {
				finish(user, errors.New("remote auth returned invalid timing"))
				return
			}
			if err := c.writePublicKey(); err != nil {
				finish(user, err)
				return
			}
			heartbeatCtx, cancel := context.WithCancel(ctx)
			heartbeatCancel = cancel
			go c.heartbeat(heartbeatCtx, time.Duration(packet.HeartbeatInterval)*time.Millisecond)
			go func(timeout time.Duration) {
				select {
				case <-time.After(timeout):
					_ = c.conn.Close()
				case <-ctx.Done():
				}
			}(time.Duration(packet.TimeoutMS) * time.Millisecond)
		case "nonce_proof":
			plaintext, err := c.decrypt(packet.EncryptedNonce)
			if err != nil {
				finish(user, fmt.Errorf("decrypt remote-auth nonce: %w", err))
				return
			}
			proof := sha256.Sum256(plaintext)
			if err := c.write(map[string]any{
				"op":    "nonce_proof",
				"proof": base64.RawURLEncoding.EncodeToString(proof[:]),
			}); err != nil {
				finish(user, err)
				return
			}
		case "pending_remote_init":
			select {
			case qr <- "https://discordapp.com/ra/" + packet.Fingerprint:
			case <-ctx.Done():
				finish(user, ctx.Err())
				return
			}
		case "pending_ticket":
			plaintext, err := c.decrypt(packet.EncryptedUserPayload)
			if err != nil {
				finish(user, fmt.Errorf("decrypt remote-auth user: %w", err))
				return
			}
			parts := strings.SplitN(string(plaintext), ":", 4)
			if len(parts) != 4 {
				finish(user, errors.New("remote auth returned malformed user identity"))
				return
			}
			user.ID, user.Discriminator, user.AvatarHash, user.Username = parts[0], parts[1], parts[2], parts[3]
		case "pending_login":
			session, err := discordgo.New("")
			if err != nil {
				finish(user, err)
				return
			}
			encryptedToken, err := session.RemoteAuthLogin(packet.Ticket)
			if err != nil {
				finish(user, fmt.Errorf("exchange remote-auth ticket: %w", err))
				return
			}
			plaintext, err := c.decrypt(encryptedToken)
			if err != nil {
				finish(user, fmt.Errorf("decrypt remote-auth token: %w", err))
				return
			}
			user.Token = string(plaintext)
			finish(user, nil)
			return
		case "cancel":
			finish(user, errors.New("remote auth was cancelled in Discord"))
			return
		case "heartbeat_ack":
			// Receipt is sufficient; the connection read deadline bounds dead peers.
		default:
			finish(user, fmt.Errorf("unsupported remote-auth operation %q", packet.OP))
			return
		}
	}
}

func (c *remoteAuthClient) heartbeat(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if err := c.write(map[string]string{"op": "heartbeat"}); err != nil {
				_ = c.conn.Close()
				return
			}
		case <-ctx.Done():
			return
		}
	}
}

func (c *remoteAuthClient) writePublicKey() error {
	encoded, err := x509.MarshalPKIXPublicKey(&c.privateKey.PublicKey)
	if err != nil {
		return fmt.Errorf("encode remote-auth public key: %w", err)
	}
	return c.write(map[string]string{
		"op":                 "init",
		"encoded_public_key": base64.RawStdEncoding.EncodeToString(encoded),
	})
}

func (c *remoteAuthClient) write(value any) error {
	c.writes.Lock()
	defer c.writes.Unlock()
	if err := c.conn.WriteJSON(value); err != nil {
		return fmt.Errorf("write remote auth: %w", err)
	}
	return nil
}

func (c *remoteAuthClient) decrypt(payload string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return nil, err
	}
	return rsa.DecryptOAEP(sha256.New(), rand.Reader, c.privateKey, raw, nil)
}
