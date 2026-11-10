// Package core — клиент Python-ядра (scripts/core_api.py).
//
// Ядро — внутренняя служба: на Railway оно живёт в приватной сети, и
// единственный, кто к нему ходит, — этот клиент. Здесь только перевод
// HTTP в вызовы и обратно; что делать с ответом, решают usecase.
package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/chat/usecase"
)

// Error — ядро ответило, но отказом.
//
// Отказ с кодом 4xx — это ошибка запроса, и его текст можно показать
// клиенту: ядро пишет его для человека. Всё остальное — поломка.
type Error struct {
	Status int
	Msg    string
}

func (e *Error) Error() string { return fmt.Sprintf("ядро: HTTP %d: %s", e.Status, e.Msg) }

// ErrUnavailable — до ядра не достучались: служба лежит, перезапускается
// или ещё строит индекс.
var ErrUnavailable = errors.New("ядро недоступно")

type Client struct {
	base  string
	token string
	// http без общего тайм-аута: ответ идёт потоком до минуты и дольше.
	// Пределы ставит контекст вызова.
	http *http.Client
}

func New(base, token string) *Client {
	return &Client{
		base:  strings.TrimRight(base, "/"),
		token: token,
		http:  &http.Client{},
	}
}

// Health — состояние ядра: модель, эмбеддинги, размер базы. Отдаётся
// как есть: набор полей принадлежит ядру и фронту, шлюз их не толкует.
func (c *Client) Health(ctx context.Context) (json.RawMessage, error) {
	return c.getJSON(ctx, "/core/health")
}

// KB — база знаний разделами, ровно как её видит модель.
func (c *Client) KB(ctx context.Context) (json.RawMessage, error) {
	return c.getJSON(ctx, "/core/kb")
}

// Chat открывает поток ответа.
func (c *Client) Chat(ctx context.Context, req chat.Request) (usecase.Stream, error) {
	body := map[string]any{"messages": req.Turns}
	if req.Mode != "" {
		body["mode"] = req.Mode
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	r, err := c.request(ctx, http.MethodPost, "/core/chat", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "text/event-stream")

	resp, err := c.http.Do(r)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		return nil, readError(resp)
	}
	return newStream(resp.Body), nil
}

func (c *Client) getJSON(ctx context.Context, path string) (json.RawMessage, error) {
	// Состояние и база отвечают за миллисекунды. Десять секунд — это
	// ядро, которое ещё поднимается, а не медленный ответ.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	r, err := c.request(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(r)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, readError(resp)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if !json.Valid(raw) {
		return nil, &Error{Status: resp.StatusCode, Msg: "ответ не JSON"}
	}
	return raw, nil
}

func (c *Client) request(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	r, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		r.Header.Set("Authorization", "Bearer "+c.token)
	}
	return r, nil
}

func readError(resp *http.Response) error {
	var body struct {
		Error string `json:"error"`
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err := json.Unmarshal(raw, &body); err != nil || body.Error == "" {
		body.Error = strings.TrimSpace(string(raw))
	}
	return &Error{Status: resp.StatusCode, Msg: body.Error}
}
