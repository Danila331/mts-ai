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
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/requestid"
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
	// breaker размыкается, когда ядро подряд не отвечает; nil — без него.
	breaker *Breaker
	// retries — сколько раз повторить открытие потока ответа (только до
	// первого байта: после него клиент уже видит текст).
	retries    int
	retryPause time.Duration
}

// Тайм-ауты соединения: ядро в приватной сети отвечает за миллисекунды,
// поэтому «не дозвонились» и «не прислало заголовки» — это поломка, а не
// медленный ответ. Сам поток ограничен контекстом вызова.
const (
	dialTimeout   = 3 * time.Second
	headerTimeout = 20 * time.Second
)

func New(base, token string) *Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DialContext = (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext
	tr.ResponseHeaderTimeout = headerTimeout
	return &Client{
		base:       strings.TrimRight(base, "/"),
		token:      token,
		http:       &http.Client{Transport: tr},
		retryPause: 300 * time.Millisecond,
	}
}

// WithBreaker включает предохранитель на вызовы ядра: после failures
// неудач подряд вызовы сразу получают ErrCircuitOpen на cooldown.
func (c *Client) WithBreaker(failures int, cooldown time.Duration) *Client {
	c.breaker = NewBreaker(failures, cooldown)
	return c
}

// WithRetries разрешает n повторов открытия потока ответа.
func (c *Client) WithRetries(n int) *Client {
	c.retries = n
	return c
}

// Degraded — ядро сейчас не принимает вызовы (предохранитель разомкнут).
func (c *Client) Degraded() bool { return c.breaker.Open() }

// guarded выполняет вызов под предохранителем. Поломкой считаются
// недоступность и ответы 5xx; отказ 4xx — ядро живо.
func (c *Client) guarded(call func() error) error {
	if err := c.breaker.Allow(); err != nil {
		return err
	}
	err := call()
	c.breaker.Done(!isFailure(err))
	return err
}

func isFailure(err error) bool {
	if err == nil {
		return false
	}
	var ce *Error
	if errors.As(err, &ce) {
		return ce.Status >= 500
	}
	return errors.Is(err, ErrUnavailable)
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

// Settings — настройки RAG ядра: текущие значения, значения из
// окружения и пределы. Набор полей принадлежит ядру и фронту.
func (c *Client) Settings(ctx context.Context) (json.RawMessage, error) {
	return c.getJSON(ctx, "/core/settings")
}

// SaveSettings меняет настройки ядра для всех ответов; тело —
// {"values": {...}} как есть, проверяет его ядро.
func (c *Client) SaveSettings(ctx context.Context, body json.RawMessage) (json.RawMessage, error) {
	return c.postJSON(ctx, "/core/settings", body)
}

// ResetSettings возвращает настройки из окружения ядра.
func (c *Client) ResetSettings(ctx context.Context) (json.RawMessage, error) {
	return c.postJSON(ctx, "/core/settings/reset", json.RawMessage(`{}`))
}

// Chat открывает поток ответа.
func (c *Client) Chat(ctx context.Context, req chat.Request) (chat.Stream, error) {
	body := map[string]any{"messages": req.Turns}
	if req.Mode != "" {
		body["mode"] = req.Mode
	}
	if len(req.Overrides) > 0 {
		body["overrides"] = req.Overrides
	}
	// Роль — подсказка промпту только в чате с клиентом: автопроверка и
	// копилот отвечают как без неё (ядро проверяет режим ещё раз).
	if req.Mode == dialog.ModeChat && req.Role.Known() {
		body["role"] = req.Role.Role
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	var stream chat.Stream
	err = c.guarded(func() error {
		var err error
		stream, err = c.openChat(ctx, raw)
		return err
	})
	if err != nil {
		return nil, err
	}
	return stream, nil
}

// openChat открывает поток с повторами: ретраи только здесь, до первого
// байта ответа. Отказ запроса (4xx) не повторяется.
func (c *Client) openChat(ctx context.Context, raw []byte) (chat.Stream, error) {
	var lastErr error
	for attempt := 0; attempt <= c.retries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, lastErr
			case <-time.After(c.retryPause * time.Duration(1<<(attempt-1))):
			}
		}
		r, err := c.request(ctx, http.MethodPost, "/core/chat", bytes.NewReader(raw))
		if err != nil {
			return nil, err
		}
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Accept", "text/event-stream")

		resp, err := c.http.Do(r)
		if err != nil {
			lastErr = fmt.Errorf("%w: %v", ErrUnavailable, err)
			continue
		}
		if resp.StatusCode != http.StatusOK {
			lastErr = readError(resp)
			_ = resp.Body.Close()
			if !isFailure(lastErr) {
				return nil, lastErr
			}
			continue
		}
		return newStream(resp.Body), nil
	}
	return nil, lastErr
}

func (c *Client) getJSON(ctx context.Context, path string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.guarded(func() error {
		var err error
		out, err = c.doGetJSON(ctx, path)
		return err
	})
	return out, err
}

func (c *Client) doGetJSON(ctx context.Context, path string) (json.RawMessage, error) {
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

func (c *Client) postJSON(ctx context.Context, path string, body json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.guarded(func() error {
		var err error
		out, err = c.doPostJSON(ctx, path, body)
		return err
	})
	return out, err
}

func (c *Client) doPostJSON(ctx context.Context, path string, body json.RawMessage) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	r, err := c.request(ctx, http.MethodPost, path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	r.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(r)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, readError(resp)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
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
	// Ядро получает тот же идентификатор обращения: по нему ответ
	// находится в обоих журналах.
	if id := requestid.From(ctx); id != "" {
		r.Header.Set(requestid.Header, id)
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
