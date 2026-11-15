// Package llm — клиент OpenAI-совместимого API модели.
//
// Тот же прокси, что у ядра (energybot/llm.py), и те же правила: ответ
// без размышлений модели, повтор на перегрузке, отказ от параметра,
// которого сервер не знает. Здесь он нужен ровно для одного — резюме
// заявки, — поэтому без эмбеддингов, реранкера и бюджета на размышления.
package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Options struct {
	BaseURL         string
	APIKey          string
	Model           string
	ThinkingParam   string
	DisableThinking bool
	Timeout         time.Duration
}

type Client struct {
	opts Options
	http *http.Client
}

func New(opts Options) *Client {
	opts.BaseURL = strings.TrimRight(opts.BaseURL, "/")
	if opts.Timeout <= 0 {
		opts.Timeout = 30 * time.Second
	}
	return &Client{opts: opts, http: &http.Client{}}
}

// Configured — есть ли куда и с чем идти. Без адреса или ключа модели
// нет, и вызывающий обходится без неё.
func (c *Client) Configured() bool { return c.opts.BaseURL != "" && c.opts.APIKey != "" }

// ErrNotConfigured — модель не настроена.
var ErrNotConfigured = errors.New("llm: модель не настроена")

// statusError — ответ сервера с кодом ошибки.
type statusError struct {
	status int
	body   string
}

func (e *statusError) Error() string { return fmt.Sprintf("llm: HTTP %d: %s", e.status, e.body) }

// retryable — перегрузка и сбои прокси. На 4xx повтор ответит тем же.
func (e *statusError) retryable() bool {
	switch e.status {
	case http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return false
}

// Chat отправляет диалог и возвращает ответ без размышлений.
func (c *Client) Chat(ctx context.Context, messages []Message, maxTokens int) (string, error) {
	if !c.Configured() {
		return "", ErrNotConfigured
	}
	body := map[string]any{
		"model":       c.opts.Model,
		"messages":    messages,
		"max_tokens":  maxTokens,
		"temperature": 0,
	}
	thinking := c.thinkingFields()
	for k, v := range thinking {
		body[k] = v
	}

	text, err := c.post(ctx, body)
	var se *statusError
	if errors.As(err, &se) && len(thinking) > 0 &&
		(se.status == http.StatusBadRequest || se.status == http.StatusUnprocessableEntity) {
		// Сервер не знает параметр режима размышлений — один повтор
		// без него. Отказаться от резюме из-за лишнего поля хуже, чем
		// получить его чуть медленнее.
		for k := range thinking {
			delete(body, k)
		}
		text, err = c.post(ctx, body)
	}
	return text, err
}

// Complete — один вопрос с указанием: system задаёт роль, user — что
// сделать. Короткая форма Chat для тех, кому диалог не нужен.
func (c *Client) Complete(ctx context.Context, system, user string, maxTokens int) (string, error) {
	return c.Chat(ctx, []Message{{Role: "system", Content: system}, {Role: "user", Content: user}}, maxTokens)
}

// thinkingFields — как попросить сервер не размышлять. У разных
// серверов разный параметр, выбирается EB_THINKING_PARAM.
func (c *Client) thinkingFields() map[string]any {
	if !c.opts.DisableThinking {
		return nil
	}
	switch c.opts.ThinkingParam {
	case "chat_template_kwargs":
		return map[string]any{"chat_template_kwargs": map[string]any{"enable_thinking": false}}
	case "reasoning":
		return map[string]any{
			"reasoning": map[string]any{"enabled": false},
			"provider":  map[string]any{"require_parameters": true},
		}
	case "enable_thinking":
		return map[string]any{"enable_thinking": false}
	}
	return nil
}

// post делает до трёх попыток с растущей паузой: прокси платформы под
// нагрузкой отвечает 429 и 5xx, и первая же неудача — ещё не отказ.
func (c *Client) post(ctx context.Context, body map[string]any) (string, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			pause := time.Duration(600*(1<<(attempt-1))) * time.Millisecond
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(pause):
			}
		}
		text, err := c.once(ctx, raw)
		if err == nil {
			return text, nil
		}
		last = err
		var se *statusError
		if errors.As(err, &se) && !se.retryable() {
			return "", err
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
	}
	return "", last
}

func (c *Client) once(ctx context.Context, raw []byte) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, c.opts.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.opts.BaseURL+"/chat/completions",
		bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.opts.APIKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", &statusError{status: resp.StatusCode, body: clip(string(data), 300)}
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", fmt.Errorf("llm: разбор ответа: %w", err)
	}
	if len(out.Choices) == 0 {
		return "", errors.New("llm: ответ без choices")
	}
	return StripThinking(out.Choices[0].Message.Content), nil
}

var think = regexp.MustCompile(`(?s)<think>.*?</think>`)

// StripThinking убирает размышления модели из ответа.
//
// Сервер отдаёт их тремя способами: отдельным полем (тогда в content
// чистый ответ), парой меток <think>…</think> или — как vLLM без разбора
// размышлений — текстом с одной закрывающей меткой. Ответ — только то,
// что после последней </think>.
func StripThinking(text string) string {
	if i := strings.LastIndex(text, "</think>"); i >= 0 {
		text = text[i+len("</think>"):]
	}
	text = think.ReplaceAllString(text, "")
	if i := strings.Index(text, "<think>"); i >= 0 {
		// Размышление не закрыто — ответа нет.
		text = text[:i]
	}
	return strings.TrimSpace(text)
}

// clip подрезает s до n байт, не разрезая символ: тело ошибки сервера
// бывает по-русски, и половина буквы в журнале — это мусор вместо
// текста.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
