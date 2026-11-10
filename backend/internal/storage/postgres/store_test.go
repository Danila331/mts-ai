package postgres

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/config"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/feedback"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	leaduc "github.com/Danila331/mts-ai/backend/internal/lead/usecase"
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
			Question: "Вопрос", Turns: 3,
		}
		require.NoError(t, s.SaveAnswer(ctx, rec))
		// Повтор доставки не дублирует и не падает.
		require.NoError(t, s.SaveAnswer(ctx, rec))

		var n int
		var guard string
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT count(*), max(guard::text) FROM answers").Scan(&n, &guard))
		assert.Equal(t, 1, n)
		assert.Equal(t, "{}", guard, "отсутствующий guard — пустой объект")
	})

	t.Run("заявка", func(t *testing.T) {
		l := lead.Lead{Code: "0123456789", Contacts: lead.Contacts{Name: "Иван"}, Summary: "s",
			Messages: []dialog.Turn{{Role: dialog.RoleUser, Content: "q"}}}
		require.NoError(t, s.CreateLead(ctx, &l))
		assert.NotZero(t, l.ID)
		assert.False(t, l.CreatedAt.IsZero())

		dup := lead.Lead{Code: "0123456789", Summary: "s"}
		assert.ErrorIs(t, s.CreateLead(ctx, &dup), leaduc.ErrCodeTaken)
	})

	t.Run("оценка", func(t *testing.T) {
		require.NoError(t, s.CreateFeedback(ctx, feedback.Feedback{MessageID: "m", Rating: feedback.Like}))
		// CHECK в базе — последняя линия, если предмет пропустил ноль.
		require.Error(t, s.CreateFeedback(ctx, feedback.Feedback{MessageID: "m", Rating: 0}))
	})
}

func TestPgx5URL(t *testing.T) {
	assert.Equal(t, "pgx5://u:p@h/db", pgx5URL("postgres://u:p@h/db"))
	assert.Equal(t, "pgx5://u:p@h/db", pgx5URL("postgresql://u:p@h/db"))
}
