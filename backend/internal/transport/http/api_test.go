package http

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
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
	"github.com/Danila331/mts-ai/backend/internal/metrics"
	"github.com/Danila331/mts-ai/backend/internal/passport"
	"github.com/Danila331/mts-ai/backend/internal/requestid"
	"github.com/Danila331/mts-ai/backend/internal/session"
)

// Тесты собирают сервер целиком — настоящие usecase, настоящий клиент
// ядра — и подменяют только внешнее: ядро — httptest-сервером с тем же
// протоколом, базу — памятью. Так проверяется контракт с фронтом, а не
// отдельные функции.

// memStore — база в памяти.
type memStore struct {
	mu        sync.Mutex
	answers   []chat.Record
	leads     []lead.Lead
	feedback  []feedback.Feedback
	sessions  map[string]session.Session
	passports map[string]passport.Passport
	// model — модель извлечения паспорта; nil — только телефон кодом.
	model passport.Model
	down  bool
}

func (m *memStore) LoadPassport(_ context.Context, id string) (passport.Passport, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.sessions[id]; !ok {
		return passport.Passport{}, session.ErrNotFound
	}
	p := m.passports[id]
	if p.Values == nil {
		p.Values = map[string]passport.Value{}
	}
	return p, nil
}

func (m *memStore) SavePassport(_ context.Context, id string, p passport.Passport) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.passports == nil {
		m.passports = map[string]passport.Passport{}
	}
	m.passports[id] = p
	return nil
}

func (m *memStore) TouchSession(_ context.Context, ref session.Ref, mode, title string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.sessions == nil {
		m.sessions = map[string]session.Session{}
	}
	s, ok := m.sessions[ref.ID]
	if !ok {
		s = session.Session{ID: ref.ID, Channel: string(ref.Channel), Title: title, Page: json.RawMessage(`{}`), CreatedAt: time.Now()}
	}
	// Как UpsertSession: страница пишется, только если пришла непустая.
	if len(ref.Page) > 0 {
		s.Page = ref.Page
	}
	s.Mode, s.UpdatedAt = mode, time.Now()
	m.sessions[ref.ID] = s
	return nil
}

func (m *memStore) History(_ context.Context, id string) (session.History, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return session.History{}, session.ErrNotFound
	}
	h := session.History{Session: s, Turns: []session.Turn{}}
	for _, a := range m.answers {
		if a.SessionID == id {
			h.Turns = append(h.Turns, session.Turn{Role: "user", Content: a.Question},
				session.Turn{Role: "assistant", Content: a.Text, AnswerID: a.ID, Sources: a.Sources()})
		}
	}
	return h, nil
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

func (m *memStore) UpdateLeadSummary(_ context.Context, l *lead.Lead) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.leads {
		if m.leads[i].Code == l.Code {
			m.leads[i] = *l
		}
	}
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
	s, store, _ := newServerWithMetrics(t, coreURL, mutate)
	return s, store
}

func newServerWithMetrics(t *testing.T, coreURL string, mutate func(*config.Config)) (*Server, *memStore, *metrics.Metrics) {
	t.Helper()
	cfg := &config.Config{Env: "test"}
	cfg.Core.URL, cfg.Core.Token = coreURL, "core-token"
	if mutate != nil {
		mutate(cfg)
	}
	store := &memStore{}
	cc := core.New(cfg.Core.URL, cfg.Core.Token)
	m := metrics.New()
	return New(cfg, Deps{
		Chat:      chatuc.New(cc, store, time.Minute).WithPassport(store, store.model),
		Leads:     leaduc.New(store, nil).WithPassports(store),
		Feedback:  feedbackuc.New(store),
		Health:    health.New(cc, store),
		KB:        cc,
		Settings:  cc,
		Sessions:  store,
		Passports: store,
		Metrics:   m,
	}, zerolog.Nop()), store, m
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
	s, _ := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) { c.HTTP.AdminToken = "admin-token" })
	admin := []string{AdminHeader, "admin-token"}

	rec := do(s, http.MethodGet, "/api/settings", "")
	require.Equal(t, http.StatusOK, rec.Code, "читать настройки может каждый")
	assert.JSONEq(t, `{"values": {"top_k": 8}, "changed": []}`, rec.Body.String(), "ответ ядра как есть")

	rec = do(s, http.MethodPost, "/api/settings", `{"values": {"top_k": 5}}`, admin...)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"values": {"top_k": 5}, "changed": ["top_k"]}`, rec.Body.String())

	rec = do(s, http.MethodPost, "/api/settings", `{"values": {"nope": 1}}`, admin...)
	assert.Equal(t, http.StatusBadRequest, rec.Code, "отказ ядра уходит клиенту с его текстом")
	assert.JSONEq(t, `{"error": "неизвестные настройки: nope"}`, rec.Body.String())

	for _, body := range []string{`{}`, `{"values": [1]}`, `{"values": "top_k=5"}`} {
		rec = do(s, http.MethodPost, "/api/settings", body, admin...)
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
	}

	rec = do(s, http.MethodPost, "/api/settings/reset", "", admin...)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"values": {"top_k": 8}, "changed": []}`, rec.Body.String())

	rec = do(s, http.MethodPost, "/api/settings/login", "", admin...)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{"ok": true}`, rec.Body.String())
}

func TestGlobalSettingsNeedAdmin(t *testing.T) {
	s, _ := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) {
		c.HTTP.Token = "front-token"
		c.HTTP.AdminToken = "admin-token"
	})
	front := []string{"Authorization", "Bearer front-token"}

	for _, path := range []string{"/api/settings", "/api/settings/reset", "/api/settings/login"} {
		rec := do(s, http.MethodPost, path, `{"values": {"top_k": 5}}`, front...)
		assert.Equal(t, http.StatusUnauthorized, rec.Code, "анонимный %s: токена прокси мало", path)
		assert.Contains(t, rec.Body.String(), "только администратор")

		rec = do(s, http.MethodPost, path, `{"values": {"top_k": 5}}`, append(front, AdminHeader, "wrong")...)
		assert.Equal(t, http.StatusUnauthorized, rec.Code, "%s с чужим токеном", path)
	}
	assert.Equal(t, http.StatusOK, do(s, http.MethodGet, "/api/settings", "", front...).Code)
	// Без токена прокси до проверки администратора дело не доходит.
	assert.Equal(t, http.StatusUnauthorized,
		do(s, http.MethodPost, "/api/settings", `{"values": {"top_k": 5}}`, AdminHeader, "admin-token").Code)
	assert.Equal(t, http.StatusOK,
		do(s, http.MethodPost, "/api/settings", `{"values": {"top_k": 5}}`, append(front, AdminHeader, "admin-token")...).Code)
}

func TestGlobalSettingsClosedWithoutAdminToken(t *testing.T) {
	s, _ := newServer(t, fakeCore(t, goodStream).URL, nil)
	for _, token := range []string{"", "anything"} {
		rec := do(s, http.MethodPost, "/api/settings", `{"values": {"top_k": 5}}`, AdminHeader, token)
		assert.Equal(t, http.StatusUnauthorized, rec.Code, "EB_ADMIN_TOKEN не задан — менять для всех нельзя никому")
	}
}

func TestSettingsLimit(t *testing.T) {
	s, _ := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) {
		c.Limits.SettingsPerMinute, c.Limits.SettingsBurst = 1, 2
	})
	// Перебор токена упирается в предел настроек.
	assert.Equal(t, http.StatusUnauthorized, do(s, http.MethodPost, "/api/settings/login", "", AdminHeader, "a").Code)
	assert.Equal(t, http.StatusUnauthorized, do(s, http.MethodPost, "/api/settings/login", "", AdminHeader, "b").Code)
	assert.Equal(t, http.StatusTooManyRequests, do(s, http.MethodPost, "/api/settings/login", "", AdminHeader, "c").Code)
	assert.Equal(t, http.StatusTooManyRequests, do(s, http.MethodGet, "/api/settings", "").Code)
	// Вопросы того же адреса предел настроек не задевает.
	assert.Equal(t, http.StatusOK,
		do(s, http.MethodPost, "/api/chat", `{"messages": [{"role": "user", "content": "q"}]}`).Code)
}

// recordingCore — ядро, которое запоминает тела запросов /core/chat и
// отказывает в настройках вне пределов, как scripts/core_api.py.
func recordingCore(t *testing.T) (*httptest.Server, func() []map[string]json.RawMessage) {
	t.Helper()
	var mu sync.Mutex
	var bodies []map[string]json.RawMessage
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		bodies = append(bodies, body)
		mu.Unlock()
		var asked struct {
			TopK int `json:"top_k"`
		}
		_ = json.Unmarshal(body["overrides"], &asked)
		if asked.TopK > 30 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error": "top_k: от 0 до 30"}`)
			return
		}
		applied := body["overrides"]
		if applied == nil {
			applied = json.RawMessage(`{}`)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: answer\ndata: {\"id\": \"a\", \"text\": \"t\", \"overrides\": "+string(applied)+"}\n\nevent: done\ndata: {}\n\n")
	}))
	t.Cleanup(srv.Close)
	return srv, func() []map[string]json.RawMessage {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]json.RawMessage(nil), bodies...)
	}
}

func answerOverrides(t *testing.T, data string) string {
	t.Helper()
	var answer struct {
		Overrides json.RawMessage `json:"overrides"`
	}
	require.NoError(t, json.Unmarshal([]byte(data), &answer))
	return string(answer.Overrides)
}

func TestChatOverridesStayInOwnRequest(t *testing.T) {
	core, bodies := recordingCore(t)
	s, _ := newServer(t, core.URL, nil)

	// Сессия жюри с песочницей и соседняя сессия без неё.
	rec := do(s, http.MethodPost, "/api/chat",
		`{"messages": [{"role": "user", "content": "q"}], "overrides": {"top_k": 3, "style": "full"}}`)
	require.Equal(t, http.StatusOK, rec.Code)
	evs := readSSE(t, rec.Body.String())
	require.Equal(t, []string{"answer", "done"}, names(evs))
	assert.JSONEq(t, `{"top_k": 3, "style": "full"}`, answerOverrides(t, evs[0].data), "фронт видит, что ответ — с его настройками")

	rec = do(s, http.MethodPost, "/api/chat", `{"messages": [{"role": "user", "content": "q"}]}`)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.JSONEq(t, `{}`, answerOverrides(t, readSSE(t, rec.Body.String())[0].data))

	got := bodies()
	require.Len(t, got, 2)
	assert.JSONEq(t, `{"top_k": 3, "style": "full"}`, string(got[0]["overrides"]), "ядро получило настройки песочницы")
	_, leaked := got[1]["overrides"]
	assert.False(t, leaked, "другая сессия отвечает с общими настройками")
}

func TestChatOverridesValidation(t *testing.T) {
	core, bodies := recordingCore(t)
	s, _ := newServer(t, core.URL, nil)
	q := `"messages": [{"role": "user", "content": "q"}]`

	for _, bad := range []string{`[1]`, `"top_k=3"`, `5`} {
		rec := do(s, http.MethodPost, "/api/chat", `{`+q+`, "overrides": `+bad+`}`)
		assert.Equal(t, http.StatusBadRequest, rec.Code, bad)
		assert.JSONEq(t, `{"error": "overrides: ожидается объект {ключ: значение}"}`, rec.Body.String(), bad)
	}
	huge := `{"style": "` + strings.Repeat("x", maxOverrides) + `"}`
	assert.Equal(t, http.StatusBadRequest, do(s, http.MethodPost, "/api/chat", `{`+q+`, "overrides": `+huge+`}`).Code)
	assert.Empty(t, bodies(), "плохая форма не доходит до ядра")

	// Пределы проверяет ядро: его отказ — 400 с текстом до начала потока.
	rec := do(s, http.MethodPost, "/api/chat", `{`+q+`, "overrides": {"top_k": 500}}`)
	assert.Equal(t, http.StatusBadRequest, rec.Code)
	assert.JSONEq(t, `{"error": "top_k: от 0 до 30"}`, rec.Body.String())

	// Пустой объект и null — общие настройки.
	for _, empty := range []string{`{}`, `null`} {
		rec = do(s, http.MethodPost, "/api/chat", `{`+q+`, "overrides": `+empty+`}`)
		assert.Equal(t, http.StatusOK, rec.Code, empty)
	}
	for _, b := range bodies()[1:] {
		_, sent := b["overrides"]
		assert.False(t, sent)
	}
}

func TestLeadAndFeedback(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, nil)

	rec := do(s, http.MethodPost, "/api/lead",
		`{"name": "Иван", "phone": "+7 900", "company": "", "comment": "", "consent": true, "messages": [{"role": "user", "content": "Нужен АСКУЭ"}]}`)
	require.Equal(t, http.StatusOK, rec.Code)
	var l struct{ ID, Summary string }
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &l))
	assert.Len(t, l.ID, 10)
	assert.True(t, strings.HasPrefix(l.Summary, "Вопросы клиента: Нужен АСКУЭ\nЧто уточнить менеджеру: "),
		"без модели — список вопросов и что уточнить: %q", l.Summary)
	require.Len(t, store.leads, 1)
	assert.Equal(t, "Иван", store.leads[0].Name)
	assert.NotEmpty(t, store.leads[0].Score.Grade, "оценка сохранена с заявкой")
	assert.NotContains(t, rec.Body.String(), "grade", "оценку видит менеджер, а не клиент")

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

func TestRequestIDReachesCoreAndJournal(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get(requestid.Header))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, goodStream)
	}))
	t.Cleanup(srv.Close)
	s, store := newServer(t, srv.URL, nil)
	body := `{"messages": [{"role": "user", "content": "q"}]}`

	rec := do(s, http.MethodPost, "/api/chat", body, requestid.Header, "front-42")
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "front-42", rec.Header().Get(requestid.Header), "годный присланный id сохраняется")
	require.Equal(t, 1, store.answerCount())
	assert.Equal(t, "front-42", store.answers[0].RequestID)

	rec = do(s, http.MethodPost, "/api/chat", body, requestid.Header, "bad id\nfake log line")
	got := rec.Header().Get(requestid.Header)
	assert.True(t, requestid.Valid(got))
	assert.NotContains(t, got, "fake", "негодный id заменяется своим")

	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, []string{"front-42", got}, seen, "ядро получает тот же id")
}

func TestChatHeartbeatWhileCoreThinks(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		f := w.(http.Flusher)
		_, _ = io.WriteString(w, "event: stage\ndata: {\"name\": \"generation\"}\n\n")
		f.Flush()
		time.Sleep(150 * time.Millisecond) // модель думает
		_, _ = io.WriteString(w, "event: answer\ndata: {\"id\": \"a1\", \"text\": \"Ответ\"}\n\nevent: done\ndata: {}\n\n")
	}))
	t.Cleanup(srv.Close)
	s, _ := newServer(t, srv.URL, func(c *config.Config) { c.HTTP.SSEHeartbeat = 20 * time.Millisecond })

	rec := do(s, http.MethodPost, "/api/chat", `{"messages": [{"role": "user", "content": "q"}]}`)
	require.Equal(t, http.StatusOK, rec.Code)
	body := rec.Body.String()
	assert.Contains(t, body, ": ping\n\n", "пока ядро думает, поток не молчит")
	var evs []string
	for _, e := range readSSE(t, body) {
		if e.name != "" {
			evs = append(evs, e.name)
		}
	}
	assert.Equal(t, []string{"stage", "answer", "done"}, evs, "комментарии не ломают события")
}

func TestMetricsCountOutcomes(t *testing.T) {
	s, _, m := newServerWithMetrics(t, fakeCore(t, goodStream).URL, nil)
	require.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/chat",
		`{"messages": [{"role": "user", "content": "q"}], "mode": "chat"}`).Code)
	require.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/lead", `{"messages": [], "consent": true}`).Code)
	do(s, http.MethodGet, "/no/such/path", "")

	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	out := rec.Body.String()
	assert.Contains(t, out, `eb_chat_answers_total{mode="chat",outcome="answered"} 1`)
	assert.Contains(t, out, `eb_leads_total{summary_source="digest"} 1`)
	assert.Contains(t, out, `eb_http_requests_total{method="POST",route="/api/chat",status="200"} 1`)
	assert.Contains(t, out, `eb_chat_streams_in_flight 0`)
	assert.NotContains(t, out, `/no/such/path`, "путь из запроса не становится меткой")
}

// Остановка ждёт поток, который ещё идёт: выкладка не обрывает ответ
// на середине и не теряет строку журнала.
func TestShutdownWaitsForStream(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: stage\ndata: {\"name\": \"generation\"}\n\n")
		w.(http.Flusher).Flush()
		<-release
		_, _ = io.WriteString(w, "event: answer\ndata: {\"id\": \"a1\"}\n\nevent: done\ndata: {}\n\n")
	}))
	t.Cleanup(srv.Close)
	s, store := newServer(t, srv.URL, nil)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	require.NoError(t, ln.Close())
	go func() { _ = s.Start(addr) }()
	require.Eventually(t, func() bool {
		c, err := net.Dial("tcp", addr)
		if err == nil {
			_ = c.Close()
		}
		return err == nil
	}, 2*time.Second, 10*time.Millisecond)

	resp, err := http.Post("http://"+addr+"/api/chat", "application/json",
		strings.NewReader(`{"messages": [{"role": "user", "content": "q"}]}`))
	require.NoError(t, err)
	defer resp.Body.Close()
	br := bufio.NewReader(resp.Body)
	line, err := br.ReadString('\n')
	require.NoError(t, err)
	require.Equal(t, "event: stage\n", line, "поток начался")

	stopped := make(chan error, 1)
	go func() { stopped <- s.Shutdown(context.Background()) }()
	select {
	case <-stopped:
		t.Fatal("Shutdown вернулся, не дождавшись потока")
	case <-time.After(200 * time.Millisecond):
	}

	close(release)
	rest, err := io.ReadAll(br)
	require.NoError(t, err)
	assert.Contains(t, string(rest), "event: answer", "ответ дошёл до клиента")
	require.NoError(t, <-stopped)
	assert.Equal(t, 1, store.answerCount(), "и лёг в журнал")
}

func TestSessionsKeepWholeDialog(t *testing.T) {
	core, bodies := recordingCore(t)
	s, store := newServer(t, core.URL, func(c *config.Config) { c.HTTP.ManagerToken = "manager-token" })
	manager := []string{ManagerHeader, "manager-token"}

	// Два вопроса одной сессии виджета — без заявки.
	for _, body := range []string{
		`{"messages": [{"role": "user", "content": "Что такое АСКУЭ?"}], "session_id": "widget-sess-1", "channel": "embed"}`,
		`{"messages": [{"role": "user", "content": "Что такое АСКУЭ?"}, {"role": "assistant", "content": "t"},
		  {"role": "user", "content": "А для склада?"}], "session_id": "widget-sess-1", "channel": "embed"}`,
	} {
		require.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/chat", body).Code)
	}
	// «Новый диалог» — новый id: новая сессия, модель видит только её реплику.
	require.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/chat",
		`{"messages": [{"role": "user", "content": "Сколько стоит?"}], "session_id": "widget-sess-2", "channel": "embed"}`).Code)

	require.Len(t, store.sessions, 2)
	got := bodies()
	require.Len(t, got, 3)
	var last []map[string]string
	require.NoError(t, json.Unmarshal(got[2]["messages"], &last))
	assert.Len(t, last, 1, "новая сессия не видит реплик прошлой")
	_, leaked := got[0]["session_id"]
	assert.False(t, leaked, "id сессии ядру не нужен")

	rec := do(s, http.MethodGet, "/api/sessions/widget-sess-1", "", manager...)
	require.Equal(t, http.StatusOK, rec.Code)
	var h session.History
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &h))
	assert.Equal(t, "embed", h.Session.Channel)
	assert.Equal(t, "Что такое АСКУЭ?", h.Session.Title, "заголовок — первая реплика")
	require.Len(t, h.Turns, 4, "две пары «вопрос — ответ»")
	assert.Equal(t, "А для склада?", h.Turns[2].Content)
	assert.Equal(t, "assistant", h.Turns[3].Role)
}

func TestSessionsNeedManager(t *testing.T) {
	s, _ := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) { c.HTTP.ManagerToken = "manager-token" })
	assert.Equal(t, http.StatusUnauthorized, do(s, http.MethodGet, "/api/sessions/widget-sess-1", "").Code)
	assert.Equal(t, http.StatusUnauthorized,
		do(s, http.MethodGet, "/api/sessions/widget-sess-1", "", ManagerHeader, "wrong").Code)
	assert.Equal(t, http.StatusNotFound,
		do(s, http.MethodGet, "/api/sessions/nobody-here", "", ManagerHeader, "manager-token").Code)

	closed, _ := newServer(t, fakeCore(t, goodStream).URL, nil)
	assert.Equal(t, http.StatusUnauthorized,
		do(closed, http.MethodGet, "/api/sessions/widget-sess-1", "", ManagerHeader, "").Code,
		"EB_MANAGER_TOKEN не задан — разговоры закрыты для всех")
}

func TestChatSessionValidation(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, nil)
	q := `"messages": [{"role": "user", "content": "q"}]`
	for body, want := range map[string]string{
		`{` + q + `, "session_id": "short"}`:                       "session_id: от 8 до 64 знаков, латиница, цифры, «-» и «_»",
		`{` + q + `, "session_id": "bad id with spaces"}`:          "session_id: от 8 до 64 знаков, латиница, цифры, «-» и «_»",
		`{` + q + `, "session_id": "good-sess-1", "channel": "x"}`: "channel: playground, embed или telegram",
	} {
		rec := do(s, http.MethodPost, "/api/chat", body)
		assert.Equal(t, http.StatusBadRequest, rec.Code, body)
		assert.JSONEq(t, `{"error": "`+want+`"}`, rec.Body.String(), body)
	}
	assert.Empty(t, store.sessions)
	// Без сессии — как раньше: ответ в журнале, сессии нет.
	require.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/chat", `{`+q+`}`).Code)
	assert.Empty(t, store.sessions)
	assert.Equal(t, 1, store.answerCount())
}

type passportModel struct {
	out string
	err error
}

func (m passportModel) Configured() bool { return true }
func (m passportModel) Complete(context.Context, string, string, int) (string, error) {
	return m.out, m.err
}

const askueStream = "event: answer\ndata: {\"id\": \"a1\", \"text\": \"Ответ\", \"mode\": \"chat\", " +
	"\"citations\": [{\"support\": [{\"id\": \"k1\", \"doc\": \"20-products/22-askue.md\"}]}]}\n\n" +
	"event: done\ndata: {}\n\n"

func TestPassportBeforeDone(t *testing.T) {
	s, store := newServer(t, fakeCore(t, askueStream).URL, nil)
	store.model = passportModel{out: `{"fields": {"object_type": "три склада", "meters": "около 40 счётчиков",
		"region": "Москва"}, "handoff_agreed": false}`}
	s, store = rebuild(t, store, fakeCore(t, askueStream).URL)

	rec := do(s, http.MethodPost, "/api/chat", `{"messages": [{"role": "user",
		"content": "У нас три склада и около 40 счётчиков, телефон пока не оставлю"}], "mode": "chat", "session_id": "sess-demo-18"}`)
	require.Equal(t, http.StatusOK, rec.Code)
	evs := readSSE(t, rec.Body.String())
	require.Equal(t, []string{"answer", "passport", "done"}, names(evs), "паспорт — после ответа и до done")
	var v passport.View
	require.NoError(t, json.Unmarshal([]byte(evs[1].data), &v))
	assert.Equal(t, passport.Platform, v.Product, "продукт — по разделу базы в опоре ответа")
	got := map[string]string{}
	for _, f := range v.Fields {
		if f.Value != "" {
			got[f.Key] = f.Value
		}
	}
	assert.Equal(t, map[string]string{"object_type": "три склада", "meters": "около 40 счётчиков"}, got,
		"регион из головы модели отброшен, контактов нет")
	assert.False(t, v.ReadyForLead, "заявка не предлагается")
	assert.Empty(t, store.leads)
}

func TestPassportFailureKeepsChat(t *testing.T) {
	store := &memStore{model: passportModel{err: errors.New("модель недоступна")}}
	s, _ := rebuild(t, store, fakeCore(t, askueStream).URL)
	rec := do(s, http.MethodPost, "/api/chat", `{"messages": [{"role": "user", "content": "звоните 8 900 000-00-00"}],
		"mode": "chat", "session_id": "sess-fail-1"}`)
	require.Equal(t, http.StatusOK, rec.Code)
	evs := readSSE(t, rec.Body.String())
	assert.Equal(t, []string{"answer", "passport", "done"}, names(evs), "ответ не потерян, телефон найден кодом")
	assert.Contains(t, evs[1].data, `+79000000000`)

	// Без сессии и в режиме автопроверки паспорта нет.
	for _, body := range []string{
		`{"messages": [{"role": "user", "content": "q"}], "mode": "chat"}`,
		`{"messages": [{"role": "user", "content": "q"}], "mode": "eval", "session_id": "sess-eval-1"}`,
	} {
		assert.Equal(t, []string{"answer", "done"}, names(readSSE(t, do(s, http.MethodPost, "/api/chat", body).Body.String())), body)
	}
}

func TestLeadFromChatWithConsent(t *testing.T) {
	store := &memStore{model: passportModel{out: `{"fields": {"name": "Тестов Тест", "phone": "+7 900 000 00 00",
		"company": "ООО Учебный склад"}, "handoff_agreed": true}`}}
	s, _ := rebuild(t, store, fakeCore(t, askueStream).URL)
	rec := do(s, http.MethodPost, "/api/chat", `{"messages": [{"role": "user",
		"content": "Тестов Тест, +7 900 000 00 00, ООО Учебный склад"}], "mode": "chat", "session_id": "sess-lead-1"}`)
	evs := readSSE(t, rec.Body.String())
	require.Len(t, evs, 3)
	var v passport.View
	require.NoError(t, json.Unmarshal([]byte(evs[1].data), &v))
	assert.True(t, v.ReadyForLead, "есть имя, телефон и компания — карточка заявки")

	lead := `{"name": "Тестов Тест", "phone": "+7 900 000 00 00", "company": "ООО Учебный склад",
		"messages": [{"role": "user", "content": "q"}], "session_id": "sess-lead-1"`
	rec = do(s, http.MethodPost, "/api/lead", lead+`}`)
	assert.Equal(t, http.StatusBadRequest, rec.Code, "без согласия заявки нет")
	assert.Contains(t, rec.Body.String(), "согласие")
	assert.Empty(t, store.leads)

	rec = do(s, http.MethodPost, "/api/lead", lead+`, "consent": true}`)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Len(t, store.leads, 1)
	assert.Equal(t, "sess-lead-1", store.leads[0].SessionID)
	assert.Contains(t, string(store.leads[0].Passport), "ООО Учебный склад", "паспорт сессии ушёл в заявку")
}

func TestPatchPassportByClient(t *testing.T) {
	store := &memStore{model: passportModel{out: `{"fields": {"region": "Тверская область"}}`}}
	s, _ := rebuild(t, store, fakeCore(t, askueStream).URL)
	do(s, http.MethodPost, "/api/chat", `{"messages": [{"role": "user", "content": "Мы в Тверская область"}],
		"mode": "chat", "session_id": "sess-edit-1"}`)

	rec := do(s, http.MethodPatch, "/api/sessions/sess-edit-1/passport", `{"values": {"region": "Тверь", "task": "поиск потерь"}}`)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Equal(t, "client", string(store.passports["sess-edit-1"].Values["region"].Source))

	for body, code := range map[string]int{
		`{"values": {"salary": "много"}}`:    http.StatusBadRequest,
		`{"values": {"phone": "позвоните"}}`: http.StatusBadRequest,
		`{"values": {"task": "майнинг"}}`:    http.StatusBadRequest,
		`{"values": {}}`:                     http.StatusBadRequest,
		`{"values": {"region": null}}`:       http.StatusOK,
	} {
		assert.Equal(t, code, do(s, http.MethodPatch, "/api/sessions/sess-edit-1/passport", body).Code, body)
	}
	assert.NotContains(t, store.passports["sess-edit-1"].Values, "region", "клиент стёр поле")
	assert.Equal(t, http.StatusNotFound, do(s, http.MethodPatch, "/api/sessions/nobody-here/passport",
		`{"values": {"region": "x"}}`).Code)
}

// rebuild — сервер над заданным хранилищем (с моделью паспорта).
func rebuild(t *testing.T, store *memStore, coreURL string) (*Server, *memStore) {
	t.Helper()
	cfg := &config.Config{Env: "test"}
	cfg.Core.URL, cfg.Core.Token = coreURL, "core-token"
	cc := core.New(cfg.Core.URL, cfg.Core.Token)
	return New(cfg, Deps{
		Chat:      chatuc.New(cc, store, time.Minute).WithPassport(store, store.model),
		Leads:     leaduc.New(store, nil).WithPassports(store),
		Feedback:  feedbackuc.New(store),
		Health:    health.New(cc, store),
		KB:        cc,
		Settings:  cc,
		Sessions:  store,
		Passports: store,
	}, zerolog.Nop()), store
}

func TestSessionKeepsWidgetPage(t *testing.T) {
	core, bodies := recordingCore(t)
	s, store := newServer(t, core.URL, func(c *config.Config) { c.HTTP.ManagerToken = "manager-token" })
	ask := func(page string) {
		t.Helper()
		body := `{"messages": [{"role": "user", "content": "Окупится ли станция?"}], "session_id": "widget-page-1", "channel": "embed"`
		if page != "" {
			body += `, "page": ` + page
		}
		require.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/chat", body+`}`).Code)
	}

	ask(`{"path": "/solar", "title": "Солнечные станции — МТС", "utm_source": "yandex", "utm_campaign": "solar-2026", "utm_term": ""}`)
	want := `{"path": "/solar", "title": "Солнечные станции — МТС", "utm_source": "yandex", "utm_campaign": "solar-2026"}`
	assert.JSONEq(t, want, string(store.sessions["widget-page-1"].Page), "пустые значения не храним")

	ask("")
	ask(`{}`)
	assert.JSONEq(t, want, string(store.sessions["widget-page-1"].Page), "вопрос без страницы её не стирает")

	ask(`{"path": "/askue", "title": "Платформа учёта"}`)
	assert.JSONEq(t, `{"path": "/askue", "title": "Платформа учёта"}`, string(store.sessions["widget-page-1"].Page),
		"клиент перешёл на другую страницу — сессия знает последнюю")

	for _, b := range bodies() {
		_, leaked := b["page"]
		assert.False(t, leaked, "страница ядру не уходит: в промпт она не попадает")
		assert.NotContains(t, string(b["messages"]), "/solar")
	}

	rec := do(s, http.MethodGet, "/api/sessions/widget-page-1", "", ManagerHeader, "manager-token")
	require.Equal(t, http.StatusOK, rec.Code)
	var h session.History
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &h))
	assert.JSONEq(t, `{"path": "/askue", "title": "Платформа учёта"}`, string(h.Session.Page))
}

func TestChatPageValidation(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, nil)
	q := `"messages": [{"role": "user", "content": "q"}], "session_id": "good-sess-1", "channel": "embed"`
	long := strings.Repeat("я", session.PageValueRunes+1)
	huge := `{"path": "/` + strings.Repeat("a", session.PageBytes) + `"}`
	for page, want := range map[string]string{
		`{"path": "/solar", "cookie": "sid=1"}`:  "page: неизвестное поле «cookie» — только path, title и utm_source|medium|campaign|term|content",
		`{"path": "/solar", "url": "https://x"}`: "page: неизвестное поле «url» — только path, title и utm_source|medium|campaign|term|content",
		`{"referrer": "https://ya.ru"}`:          "page: неизвестное поле «referrer» — только path, title и utm_source|medium|campaign|term|content",
		`{"utm_id": "1"}`:                        "page: неизвестное поле «utm_id» — только path, title и utm_source|medium|campaign|term|content",
		`{"path": 1}`:                            "page.path: ожидается строка",
		`{"title": {"x": "y"}}`:                  "page.title: ожидается строка",
		`{"title": "` + long + `"}`:              "page.title: не длиннее 300 знаков",
		`["/solar"]`:                             "page: ожидается объект {path, title, utm_*}",
		`"/solar"`:                               "page: ожидается объект {path, title, utm_*}",
		huge:                                     "page: не больше 2048 байт",
	} {
		rec := do(s, http.MethodPost, "/api/chat", `{`+q+`, "page": `+page+`}`)
		assert.Equal(t, http.StatusBadRequest, rec.Code, page)
		assert.JSONEq(t, `{"error": "`+want+`"}`, rec.Body.String(), page)
	}
	assert.Empty(t, store.sessions, "отказ — до записи сессии")
	assert.Zero(t, store.answerCount(), "и до ядра")

	// Ровно на пределе — принимается; null — как без страницы.
	edge := `{"title": "` + strings.Repeat("я", session.PageValueRunes) + `"}`
	require.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/chat", `{`+q+`, "page": `+edge+`}`).Code)
	require.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/chat",
		`{"messages": [{"role": "user", "content": "q"}], "session_id": "good-sess-2", "page": null}`).Code)
	assert.JSONEq(t, `{}`, string(store.sessions["good-sess-2"].Page))
}
