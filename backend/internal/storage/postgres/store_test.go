package postgres

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/config"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/feedback"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/lead/score"
	"github.com/Danila331/mts-ai/backend/internal/privacy"
	"github.com/Danila331/mts-ai/backend/internal/session"
)

// Тесты хранилища идут против живого Postgres: моки базы проверяют
// моки, а ошибки здесь — про поведение самой базы (CHECK, UNIQUE, jsonb).
// Без TEST_DATABASE_URL они пропускаются, в CI он задан всегда.
func openTest(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL не задан")
	}
	require.NoError(t, Migrate(dsn))
	// Повторный накат — то, что происходит при каждом рестарте службы.
	require.NoError(t, Migrate(dsn))

	s, err := Open(context.Background(), config.DB{DSN: dsn, MaxConns: 4})
	require.NoError(t, err)
	t.Cleanup(s.Close)
	_, err = s.Pool.Exec(context.Background(), "TRUNCATE answers, leads, feedback, sessions")
	require.NoError(t, err)
	return s
}

func TestStore(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()

	t.Run("журнал ответов", func(t *testing.T) {
		rec := chat.Record{
			Answer:   chat.Answer{ID: "abc", Text: "Ответ", Mode: "chat", Timings: json.RawMessage(`{"total": 12}`)},
			Question: "Вопрос", Turns: 3, RequestID: "req-1",
		}
		require.NoError(t, s.SaveAnswer(ctx, rec))
		// Повтор доставки не дублирует и не падает.
		require.NoError(t, s.SaveAnswer(ctx, rec))

		var n int
		var guard string
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT count(*), max(guard::text) FROM answers").Scan(&n, &guard))
		assert.Equal(t, 1, n)
		assert.Equal(t, "{}", guard, "отсутствующий guard — пустой объект")

		var reqID string
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT request_id FROM answers WHERE id = 'abc'").Scan(&reqID))
		assert.Equal(t, "req-1", reqID)
	})

	t.Run("заявка", func(t *testing.T) {
		l := lead.Lead{Code: "0123456789", Contacts: lead.Contacts{Name: "Иван"}, Summary: "s",
			Messages: []dialog.Turn{{Role: dialog.RoleUser, Content: "q"}}}
		require.NoError(t, s.CreateLead(ctx, &l))
		assert.NotZero(t, l.ID)
		assert.False(t, l.CreatedAt.IsZero())

		dup := lead.Lead{Code: "0123456789", Summary: "s"}
		assert.ErrorIs(t, s.CreateLead(ctx, &dup), lead.ErrCodeTaken)

		var source, scored string
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT summary_source, score::text FROM leads WHERE id = $1", l.ID).
			Scan(&source, &scored))
		assert.Equal(t, "digest", source, "без источника — список вопросов")
		assert.Equal(t, "{}", scored, "заявка без оценки — пустой объект")

		withScore := lead.Lead{Code: "9876543210", Summary: "s", Score: score.Score{Grade: score.Warm, Points: 55,
			Reasons: []string{"Подходит: Платформа учёта"}, Missing: []string{"схема сбора данных"}, Product: "platform"}}
		require.NoError(t, s.CreateLead(ctx, &withScore))
		var raw []byte
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT score FROM leads WHERE id = $1", withScore.ID).Scan(&raw))
		var back score.Score
		require.NoError(t, json.Unmarshal(raw, &back))
		assert.Equal(t, withScore.Score, back, "оценка лежит в заявке как есть")

		var callback string
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT callback_preference::text FROM leads WHERE id = $1", l.ID).Scan(&callback))
		assert.Equal(t, "{}", callback, "время не выбрано — пустой объект")
		withCallback := lead.Lead{Code: "5555555555", Summary: "s",
			Contacts: lead.Contacts{Callback: lead.Callback{Time: "day", Timezone: "Europe/Moscow"}}}
		require.NoError(t, s.CreateLead(ctx, &withCallback))
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT callback_preference FROM leads WHERE id = $1", withCallback.ID).Scan(&raw))
		assert.JSONEq(t, `{"time": "day", "timezone": "Europe/Moscow"}`, string(raw))

		var kind string
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT kind FROM leads WHERE id = $1", l.ID).Scan(&kind))
		assert.Equal(t, "callback", kind, "без типа — обратный звонок")
		demo := lead.Lead{Code: "7777777777", Summary: "s", Contacts: lead.Contacts{Kind: lead.KindDemo}}
		require.NoError(t, s.CreateLead(ctx, &demo))
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT kind FROM leads WHERE id = $1", demo.ID).Scan(&kind))
		assert.Equal(t, "demo", kind)
		bad := lead.Lead{Code: "8888888888", Summary: "s", Contacts: lead.Contacts{Kind: "meeting"}}
		assert.Error(t, s.CreateLead(ctx, &bad), "тип вне списка не пройдёт и мимо сервиса: CHECK в базе")

		l.Summary, l.SummarySource = "резюме моделью", lead.SummaryLLM
		require.NoError(t, s.UpdateLeadSummary(ctx, &l))
		var summary string
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT summary, summary_source FROM leads WHERE id = $1", l.ID).
			Scan(&summary, &source))
		assert.Equal(t, "резюме моделью", summary)
		assert.Equal(t, "llm", source)

		missing := lead.Lead{Summary: "x", SummarySource: lead.SummaryLLM}
		assert.Error(t, s.UpdateLeadSummary(ctx, &missing), "обновить несуществующую заявку — ошибка, а не тишина")
	})

	t.Run("сессия", func(t *testing.T) {
		ref := session.Ref{ID: "widget-sess-1", Channel: session.Embed}
		var first chat.Answer
		require.NoError(t, json.Unmarshal([]byte(`{"id": "s1", "text": "Ответ 1", "mode": "chat",
			"citations": [{"support": [{"id": "kb-1"}, {"id": "kb-2"}]}]}`), &first))
		require.NoError(t, s.TouchSession(ctx, ref, "chat", "Первый вопрос", session.RoleHint{}))
		require.NoError(t, s.SaveAnswer(ctx, chat.Record{Answer: first, Question: "Первый вопрос", Turns: 1, SessionID: ref.ID}))
		require.NoError(t, s.TouchSession(ctx, ref, "chat", "Второй вопрос", session.RoleHint{}))
		require.NoError(t, s.SaveAnswer(ctx, chat.Record{
			Answer: chat.Answer{ID: "s2", Text: "Ответ 2", Mode: "chat"}, Question: "Второй вопрос", Turns: 3, SessionID: ref.ID,
		}))

		h, err := s.History(ctx, ref.ID)
		require.NoError(t, err)
		assert.Equal(t, "embed", h.Session.Channel)
		assert.Equal(t, "Первый вопрос", h.Session.Title, "заголовок остаётся от первого вопроса")
		assert.JSONEq(t, `{}`, string(h.Session.Page))
		require.Len(t, h.Turns, 4)
		assert.Equal(t, []string{"Первый вопрос", "Ответ 1", "Второй вопрос", "Ответ 2"},
			[]string{h.Turns[0].Content, h.Turns[1].Content, h.Turns[2].Content, h.Turns[3].Content})
		assert.Equal(t, []string{"kb-1", "kb-2"}, h.Turns[1].Sources)

		// Страница виджета (T8): пишется при создании, пустая её не стирает,
		// непустая заменяет.
		paged := session.Ref{ID: "widget-page-1", Channel: session.Embed,
			Page: json.RawMessage(`{"path": "/solar", "utm_source": "yandex"}`)}
		require.NoError(t, s.TouchSession(ctx, paged, "chat", "Про солнце", session.RoleHint{}))
		h, err = s.History(ctx, paged.ID)
		require.NoError(t, err)
		assert.JSONEq(t, `{"path": "/solar", "utm_source": "yandex"}`, string(h.Session.Page))
		require.NoError(t, s.TouchSession(ctx, session.Ref{ID: paged.ID, Channel: session.Embed}, "chat", "Ещё", session.RoleHint{}))
		h, err = s.History(ctx, paged.ID)
		require.NoError(t, err)
		assert.JSONEq(t, `{"path": "/solar", "utm_source": "yandex"}`, string(h.Session.Page), "вопрос без страницы её не стирает")
		paged.Page = json.RawMessage(`{"path": "/askue", "title": "Платформа учёта"}`)
		require.NoError(t, s.TouchSession(ctx, paged, "chat", "Ещё", session.RoleHint{}))
		h, err = s.History(ctx, paged.ID)
		require.NoError(t, err)
		assert.JSONEq(t, `{"path": "/askue", "title": "Платформа учёта"}`, string(h.Session.Page))
		assert.Equal(t, "Про солнце", h.Session.Title)

		// Роль (T15): пишется, когда известна или снята клиентом; вопрос без
		// роли её не стирает.
		roled := session.Ref{ID: "widget-role-1", Channel: session.Embed}
		role := func() (string, string) {
			h, err := s.History(ctx, roled.ID)
			require.NoError(t, err)
			return h.Session.Role, h.Session.RoleSource
		}
		require.NoError(t, s.TouchSession(ctx, roled, "chat", "Мы сетевая компания", session.RoleHint{}))
		r, src := role()
		assert.Equal(t, [2]string{"", ""}, [2]string{r, src}, "роли ещё нет")
		require.NoError(t, s.TouchSession(ctx, roled, "chat", "Ещё",
			session.RoleHint{Role: session.RoleGrid, Source: session.RoleAuto}))
		r, src = role()
		assert.Equal(t, [2]string{"grid", "auto"}, [2]string{r, src})
		require.NoError(t, s.TouchSession(ctx, roled, "chat", "Ещё", session.RoleHint{}))
		r, src = role()
		assert.Equal(t, [2]string{"grid", "auto"}, [2]string{r, src}, "вопрос без роли её не стирает")
		require.NoError(t, s.TouchSession(ctx, roled, "chat", "Ещё",
			session.RoleHint{Role: session.RoleEngineer, Source: session.RoleByClient}))
		r, src = role()
		assert.Equal(t, [2]string{"engineer", "client"}, [2]string{r, src}, "выбор клиента")
		require.NoError(t, s.TouchSession(ctx, roled, "chat", "Ещё", session.RoleHint{Source: session.RoleByClient}))
		r, src = role()
		assert.Equal(t, [2]string{"", "client"}, [2]string{r, src}, "клиент снял роль")
		assert.Error(t, s.TouchSession(ctx, roled, "chat", "Ещё", session.RoleHint{Role: session.RoleGrid, Source: "model"}),
			"CHECK в базе — последняя линия для неизвестного источника роли")

		_, err = s.History(ctx, "nobody-here")
		assert.ErrorIs(t, err, session.ErrNotFound)
		assert.Error(t, s.TouchSession(ctx, session.Ref{ID: "x-sess-01", Channel: "fax"}, "chat", "", session.RoleHint{}),
			"CHECK в базе — последняя линия для неизвестного канала")
	})

	t.Run("оценка", func(t *testing.T) {
		require.NoError(t, s.CreateFeedback(ctx, feedback.Feedback{MessageID: "m", Rating: feedback.Like}))
		// CHECK в базе — последняя линия, если предмет пропустил ноль.
		require.Error(t, s.CreateFeedback(ctx, feedback.Feedback{MessageID: "m", Rating: 0}))
	})
}

func TestPrivacy(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := s.Pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}
	count := func(table string) (n int) {
		t.Helper()
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&n))
		return n
	}

	t.Run("очистка по сроку", func(t *testing.T) {
		exec("TRUNCATE answers, leads, feedback, sessions")
		exec(`INSERT INTO leads (code, summary, created_at) VALUES ('old', 's', now() - interval '100 days'), ('new', 's', now())`)
		exec(`INSERT INTO answers (id, mode, question, answer, turns, created_at)
		      VALUES ('a-old', 'chat', 'q', 'a', 1, now() - interval '40 days'), ('a-new', 'chat', 'q', 'a', 1, now())`)
		exec(`INSERT INTO feedback (rating, created_at) VALUES (1, now() - interval '100 days')`)
		exec(`INSERT INTO sessions (id, title, updated_at) VALUES ('sess-old-1', 'q', now() - interval '40 days'), ('sess-new-1', 'q', now())`)

		now := time.Now()
		n, locked, err := s.Purge(ctx, privacy.Policy{
			Leads: 90 * 24 * time.Hour, Answers: 30 * 24 * time.Hour,
		}.Cutoffs(now))
		require.NoError(t, err)
		assert.True(t, locked)
		assert.Equal(t, privacy.Counts{Leads: 1, Answers: 1, Sessions: 1}, n)
		assert.Equal(t, 1, count("sessions"), "сессия живёт столько же, сколько журнал ответов")
		assert.Equal(t, 1, count("leads"))
		assert.Equal(t, 1, count("answers"))
		assert.Equal(t, 1, count("feedback"), "срок оценок не задан — не тронуты")
	})

	t.Run("одна реплика за раз", func(t *testing.T) {
		tx, err := s.Pool.Begin(ctx)
		require.NoError(t, err)
		defer func() { _ = tx.Rollback(ctx) }()
		var got bool
		require.NoError(t, tx.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock(hashtext('energytool:retention'))").Scan(&got))
		require.True(t, got)

		_, locked, err := s.Purge(ctx, privacy.Cutoffs{Leads: time.Now()})
		require.NoError(t, err)
		assert.False(t, locked, "блокировку держит другая «реплика» — проход пропущен")
	})

	t.Run("удаление по запросу", func(t *testing.T) {
		exec("TRUNCATE answers, leads, feedback, sessions")
		exec(`INSERT INTO leads (code, phone, summary) VALUES ('c1', '8 (900) 123-45-67', 's'), ('c2', '+7 911 000-00-00', 's')`)
		exec(`INSERT INTO leads (code, phone, summary, messages) VALUES ('c3', '', 's', '[{"role":"user","content":"звоните +7 900 1234567"}]')`)
		exec(`INSERT INTO answers (id, mode, question, answer, turns) VALUES ('a1', 'chat', 'мой номер 900-123-45-67', 'a', 1), ('a2', 'chat', 'АСКУЭ', 'a', 1)`)
		exec(`INSERT INTO feedback (rating, comment) VALUES (1, 'перезвоните 89001234567'), (1, 'ок')`)
		exec(`INSERT INTO sessions (id, title) VALUES ('sess-num-1', 'мой номер 8 900 123 45 67'), ('sess-other', 'АСКУЭ')`)
		subj, err := privacy.NewSubject("+7 900 123 45 67", "")
		require.NoError(t, err)

		dry, err := s.Forget(ctx, subj, true)
		require.NoError(t, err)
		assert.Equal(t, privacy.Counts{Leads: 2, Answers: 1, Feedback: 1, Sessions: 1}, dry)
		assert.Equal(t, 3, count("leads"), "пробный прогон ничего не удаляет")

		n, err := s.Forget(ctx, subj, false)
		require.NoError(t, err)
		assert.Equal(t, dry, n)
		assert.Equal(t, 1, count("leads"), "чужая заявка осталась")
		assert.Equal(t, 1, count("answers"))
		assert.Equal(t, 1, count("feedback"))
		assert.Equal(t, 1, count("sessions"))

		byCode, err := privacy.NewSubject("", "c2")
		require.NoError(t, err)
		n, err = s.Forget(ctx, byCode, false)
		require.NoError(t, err)
		assert.Equal(t, int64(1), n.Leads)
	})
}

func TestPgx5URL(t *testing.T) {
	assert.Equal(t, "pgx5://u:p@h/db", pgx5URL("postgres://u:p@h/db"))
	assert.Equal(t, "pgx5://u:p@h/db", pgx5URL("postgresql://u:p@h/db"))
}
