package http

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	chatuc "github.com/Danila331/mts-ai/backend/internal/chat/usecase"
	"github.com/Danila331/mts-ai/backend/internal/config"
	"github.com/Danila331/mts-ai/backend/internal/core"
	"github.com/Danila331/mts-ai/backend/internal/feedback"
	feedbackuc "github.com/Danila331/mts-ai/backend/internal/feedback/usecase"
	"github.com/Danila331/mts-ai/backend/internal/health"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	leaduc "github.com/Danila331/mts-ai/backend/internal/lead/usecase"
)

// Тесты собирают сервер целиком — настоящие usecase, настоящий клиент
// ядра — и подменяют только внешнее: ядро — httptest-сервером с тем же
// протоколом, базу — памятью. Так проверяется контракт с фронтом, а не
// отдельные функции.

// memStore — база в памяти.
type memStore struct {
	mu       sync.Mutex
	answers  []chat.Record
	leads    []lead.Lead
	feedback []feedback.Feedback
	down     bool
}

func (m *memStore) SaveAnswer(_ context.Context, r chat.Record) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.answers = append(m.answers, r)
	return nil
}

func (m *memStore) CreateLead(_ context.Context, l *lead.Lead) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.leads = append(m.leads, *l)
	return nil
}

func (m *memStore) CreateFeedback(_ context.Context, f feedback.Feedback) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.feedback = append(m.feedback, f)
	return nil
}

func (m *memStore) Ping(context.Context) error {
	if m.down {
		return errors.New("down")
	}
	return nil
}

func (m *memStore) answerCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.answers)
}

// fakeCore — ядро с протоколом scripts/core_api.py.
func fakeCore(t *testing.T, chatBody string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer core-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/core/health":
			_, _ = io.WriteString(w, `{"ok": true, "arch": "v3", "llm": true, "chunks": 120, "mode": "chat"}`)
		case "/core/kb":
			_, _ = io.WriteString(w, `{"fingerprint": "f", "docs": []}`)
		case "/core/chat":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, chatBody)
		case "/core/settings":
			if r.Method == http.MethodGet {
				_, _ = io.WriteString(w, `{"values": {"top_k": 8}, "changed": []}`)
				return
			}
			raw, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(raw), `"top_k"`) {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"error": "неизвестные настройки: nope"}`)
				return
			}
			_, _ = io.WriteString(w, `{"values": {"top_k": 5}, "changed": ["top_k"]}`)
		case "/core/settings/reset":
			_, _ = io.WriteString(w, `{"values": {"top_k": 8}, "changed": []}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

const goodStream = "event: stage\ndata: {\"name\": \"retrieval\", \"hits\": []}\n\n" +
	"event: stage\ndata: {\"name\": \"generation\"}\n\n" +
	"event: answer\ndata: {\"id\": \"a1\", \"text\": \"Ответ\", \"mode\": \"chat\", \"timings\": {\"total\": 5}, \"prompt\": []}\n\n" +
	"event: done\ndata: {}\n\n"

func newServer(t *testing.T, coreURL string, mutate func(*config.Config)) (*Server, *memStore) {
	t.Helper()
	cfg := &config.Config{Env: "test"}
	cfg.Core.URL, cfg.Core.Token = coreURL, "core-token"
	if mutate != nil {
		mutate(cfg)
	}
	store := &memStore{}
	cc := core.New(cfg.Core.URL, cfg.Core.Token)
	log := zerolog.Nop()
	return New(cfg, Deps{
		Chat:     chatuc.New(cc, store, log, time.Minute),
		Leads:    leaduc.New(store, nil, log),
		Feedback: feedbackuc.New(store),
		Health:   health.New(cc, store),
		KB:       cc,
		Settings: cc,
	}, log), store
}

func do(s *Server, method, path, body string, headers ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

type sse struct{ name, data string }

func readSSE(t *testing.T, body string) []sse {
	t.Helper()
	var out []sse
	var cur sse
	sc := bufio.NewScanner(strings.NewReader(body))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "event: "):
			cur.name = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			cur.data = strings.TrimPrefix(line, "data: ")
		case line == "":
			out = append(out, cur)
			cur = sse{}
		}
	}
	return out
}

func names(evs []sse) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.name)
	}
	return out
}

func TestChatRelaysStreamAndJournals(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, nil)
	rec := do(s, http.MethodPost, "/api/chat",
		`{"messages": [{"role": "user", "content": "Что такое АСКУЭ?"}], "mode": "chat"}`)

	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "text/event-stream; charset=utf-8", rec.Header().Get("Content-Type"))
	evs := readSSE(t, rec.Body.String())
	assert.Equal(t, []string{"stage", "stage", "answer", "done"}, names(evs))
	assert.JSONEq(t, `{"id": "a1", "text": "Ответ", "mode": "chat", "timings": {"total": 5}, "prompt": []}`,
		evs[2].data, "ответ ядра уходит фронту байт в байт")

	require.Equal(t, 1, store.answerCount())
	assert.Equal(t, "Что такое АСКУЭ?", store.answers[0].Question)
	assert.Equal(t, "a1", store.answers[0].ID)
}

func TestChatCutStreamEndsWithError(t *testing.T) {
	s, store := newServer(t, fakeCore(t, "event: stage\ndata: {\"name\": \"retrieval\"}\n\nevent: answer\ndata: {\"id").URL, nil)
	rec := do(s, http.MethodPost, "/api/chat", `{"messages": [{"role": "user", "content": "q"}]}`)
	require.Equal(t, http.StatusOK, rec.Code)
	evs := readSSE(t, rec.Body.String())
	assert.Equal(t, []string{"stage", "error", "done"}, names(evs))
	assert.Equal(t, 0, store.answerCount())
}

func TestChatValidationBeforeStream(t *testing.T) {
	s, _ := newServer(t, fakeCore(t, goodStream).URL, nil)
	for body, want := range map[string]string{
		`{"messages": [{"role": "assistant", "content": "a"}]}`: "последняя реплика должна быть от пользователя",
		`{"messages": "текст"}`:                                 "messages: ожидается список реплик",
		`[1, 2]`:                                                "ожидается JSON-объект",
		``:                                                      "messages: ожидается список реплик",
	} {
		rec := do(s, http.MethodPost, "/api/chat", body)
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
		assert.JSONEq(t, `{"error": "`+want+`"}`, rec.Body.String(), body)
	}
}

func TestChatCoreDown(t *testing.T) {
	dead := httptest.NewServer(http.NotFoundHandler())
	dead.Close()
	s, _ := newServer(t, dead.URL, nil)
	rec := do(s, http.MethodPost, "/api/chat", `{"messages": [{"role": "user", "content": "q"}]}`)
	assert.Equal(t, http.StatusBadGateway, rec.Code)
	assert.Contains(t, rec.Body.String(), "Ядро консультанта")
}

func TestHealthAndKB(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, nil)

	rec := do(s, http.MethodGet, "/api/health", "")
	require.Equal(t, http.StatusOK, rec.Code)
	var h map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &h))
	assert.Equal(t, "v3", h["arch"], "поля ядра проходят как есть")
	assert.Equal(t, true, h["db"])

	rec = do(s, http.MethodGet, "/api/kb", "")
	assert.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"fingerprint": "f", "docs": []}`, rec.Body.String())

	assert.Equal(t, http.StatusOK, do(s, http.MethodGet, "/healthz", "").Code)
	store.down = true
	assert.Equal(t, http.StatusServiceUnavailable, do(s, http.MethodGet, "/healthz", "").Code)
	assert.Equal(t, http.StatusNotFound, do(s, http.MethodGet, "/api/unknown", "").Code)
}

func TestSettings(t *testing.T) {
	s, _ := newServer(t, fakeCore(t, goodStream).URL, nil)

	rec := do(s, http.MethodGet, "/api/settings", "")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"values": {"top_k": 8}, "changed": []}`, rec.Body.String(), "ответ ядра как есть")

	rec = do(s, http.MethodPost, "/api/settings", `{"values": {"top_k": 5}}`)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"values": {"top_k": 5}, "changed": ["top_k"]}`, rec.Body.String())

	rec = do(s, http.MethodPost, "/api/settings", `{"values": {"nope": 1}}`)
	assert.Equal(t, http.StatusBadRequest, rec.Code, "отказ ядра уходит клиенту с его текстом")
	assert.JSONEq(t, `{"error": "неизвестные настройки: nope"}`, rec.Body.String())

	for _, body := range []string{`{}`, `{"values": [1]}`, `{"values": "top_k=5"}`} {
		rec = do(s, http.MethodPost, "/api/settings", body)
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
	}

	rec = do(s, http.MethodPost, "/api/settings/reset", "")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"values": {"top_k": 8}, "changed": []}`, rec.Body.String())
}

func TestLeadAndFeedback(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, nil)

	rec := do(s, http.MethodPost, "/api/lead",
		`{"name": "Иван", "phone": "+7 900", "company": "", "comment": "", "messages": [{"role": "user", "content": "Нужен АСКУЭ"}]}`)
	require.Equal(t, http.StatusOK, rec.Code)
	var l struct{ ID, Summary string }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &l))
	assert.Len(t, l.ID, 10)
	assert.Equal(t, "Вопросы клиента: Нужен АСКУЭ", l.Summary, "без модели — список вопросов")
	require.Len(t, store.leads, 1)
	assert.Equal(t, "Иван", store.leads[0].Name)

	rec = do(s, http.MethodPost, "/api/feedback", `{"session_id": "s", "message_id": "m", "rating": -1, "comment": "мимо"}`)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"ok": true}`, rec.Body.String())
	require.Len(t, store.feedback, 1)
	assert.Equal(t, feedback.Dislike, store.feedback[0].Rating)

	rec = do(s, http.MethodPost, "/api/feedback", `{"message_id": "m", "rating": 5}`)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
}

func TestTokenAndClientLimit(t *testing.T) {
	s, _ := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) {
		c.HTTP.Token = "front-token"
		c.Limits.FeedbackPerMinute, c.Limits.FeedbackBurst = 1, 1
	})
	body := `{"message_id": "m", "rating": 1}`

	assert.Equal(t, http.StatusUnauthorized, do(s, http.MethodGet, "/api/health", "").Code)
	assert.Equal(t, http.StatusUnauthorized,
		do(s, http.MethodGet, "/api/health", "", "Authorization", "Bearer wrong").Code)
	// Проба хостинга токена не требует.
	assert.Equal(t, http.StatusOK, do(s, http.MethodGet, "/healthz", "").Code)

	auth := []string{"Authorization", "Bearer front-token"}
	first := append(auth, "X-Client-IP", "1.1.1.1")
	assert.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/feedback", body, first...).Code)
	assert.Equal(t, http.StatusTooManyRequests, do(s, http.MethodPost, "/api/feedback", body, first...).Code)
	// Предел — на клиента, а не на прокси: другой адрес за тем же
	// прокси не упирается в чужой предел.
	second := append(auth, "X-Client-IP", "2.2.2.2")
	assert.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/feedback", body, second...).Code)
}
