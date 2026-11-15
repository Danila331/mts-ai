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
	"github.com/Danila331/mts-ai/backend/internal/privacy"
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
	_, err = s.Pool.Exec(context.Background(), "TRUNCATE answers, leads, feedback")
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

		var source string
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT summary_source FROM leads WHERE id = $1", l.ID).Scan(&source))
		assert.Equal(t, "digest", source, "без источника — список вопросов")

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
		exec("TRUNCATE answers, leads, feedback")
		exec(`INSERT INTO leads (code, summary, created_at) VALUES ('old', 's', now() - interval '100 days'), ('new', 's', now())`)
		exec(`INSERT INTO answers (id, mode, question, answer, turns, created_at)
		      VALUES ('a-old', 'chat', 'q', 'a', 1, now() - interval '40 days'), ('a-new', 'chat', 'q', 'a', 1, now())`)
		exec(`INSERT INTO feedback (rating, created_at) VALUES (1, now() - interval '100 days')`)

		now := time.Now()
		n, locked, err := s.Purge(ctx, privacy.Policy{
			Leads: 90 * 24 * time.Hour, Answers: 30 * 24 * time.Hour,
		}.Cutoffs(now))
		require.NoError(t, err)
		assert.True(t, locked)
		assert.Equal(t, privacy.Counts{Leads: 1, Answers: 1}, n)
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
		exec("TRUNCATE answers, leads, feedback")
		exec(`INSERT INTO leads (code, phone, summary) VALUES ('c1', '8 (900) 123-45-67', 's'), ('c2', '+7 911 000-00-00', 's')`)
		exec(`INSERT INTO leads (code, phone, summary, messages) VALUES ('c3', '', 's', '[{"role":"user","content":"звоните +7 900 1234567"}]')`)
		exec(`INSERT INTO answers (id, mode, question, answer, turns) VALUES ('a1', 'chat', 'мой номер 900-123-45-67', 'a', 1), ('a2', 'chat', 'АСКУЭ', 'a', 1)`)
		exec(`INSERT INTO feedback (rating, comment) VALUES (1, 'перезвоните 89001234567'), (1, 'ок')`)
		subj, err := privacy.NewSubject("+7 900 123 45 67", "")
		require.NoError(t, err)

		dry, err := s.Forget(ctx, subj, true)
		require.NoError(t, err)
		assert.Equal(t, privacy.Counts{Leads: 2, Answers: 1, Feedback: 1}, dry)
		assert.Equal(t, 3, count("leads"), "пробный прогон ничего не удаляет")

		n, err := s.Forget(ctx, subj, false)
		require.NoError(t, err)
		assert.Equal(t, dry, n)
		assert.Equal(t, 1, count("leads"), "чужая заявка осталась")
		assert.Equal(t, 1, count("answers"))
		assert.Equal(t, 1, count("feedback"))

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
