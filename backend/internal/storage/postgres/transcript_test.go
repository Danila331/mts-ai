package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/privacy"
	"github.com/Danila331/mts-ai/backend/internal/session"
)

func u(s string) dialog.Turn { return dialog.Turn{Role: dialog.RoleUser, Content: s} }
func a(s string) dialog.Turn { return dialog.Turn{Role: dialog.RoleAssistant, Content: s} }

func contents(h session.History) []string {
	out := make([]string, 0, len(h.Turns))
	for _, t := range h.Turns {
		out = append(out, t.Role+": "+t.Content)
	}
	return out
}

// Переписка хранится целиком: реплики до сессии, вопросы без ответа,
// реплики фронта; повторы не дублируются, копилот не пишет.
func TestSessionTranscript(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	ref := session.Ref{ID: "trans-sess-1", Channel: session.Embed}
	touch := func(mode string) {
		t.Helper()
		require.NoError(t, s.TouchSession(ctx, ref, mode, "t", session.RoleHint{}, session.LevelChoice{}))
	}
	answer := func(id, text string) {
		t.Helper()
		require.NoError(t, s.SaveAnswer(ctx, chat.Record{Answer: chat.Answer{ID: id, Text: text, Mode: "chat"}, SessionID: ref.ID}))
	}

	// Синхронизация без сессии — тихо ничего (сессия не создана).
	require.NoError(t, s.SyncTurns(ctx, "nobody-sess-1", []dialog.Turn{u("x")}))

	touch("chat")
	require.NoError(t, s.SyncTurns(ctx, ref.ID, []dialog.Turn{a("Здравствуйте!"), u("Привет")}))
	answer("t1", "Чем помочь?")
	answer("t1", "Чем помочь?") // повтор доставки

	touch("chat")
	require.NoError(t, s.SyncTurns(ctx, ref.ID, []dialog.Turn{a("Здравствуйте!"), u("Привет"), a("Чем  помочь?"), u("Цена?")}))
	// Ядро не ответило; клиент повторил тот же запрос.
	touch("chat")
	retry := []dialog.Turn{u("Привет"), a("Чем помочь?"), u("Цена?"), a("Оставьте номер"), u("Ещё вопрос")}
	require.NoError(t, s.SyncTurns(ctx, ref.ID, retry))
	require.NoError(t, s.SyncTurns(ctx, ref.ID, retry))

	// Копилот менеджера в эту же сессию не пишет.
	touch("copilot")
	require.NoError(t, s.SyncTurns(ctx, ref.ID, []dialog.Turn{u("копилот")}))
	answer("t2", "ответ копилота")
	touch("chat")

	h, err := s.History(ctx, ref.ID)
	require.NoError(t, err)
	assert.Equal(t, []string{
		"assistant: Здравствуйте!", "user: Привет", "assistant: Чем помочь?", "user: Цена?",
		"assistant: Оставьте номер", "user: Ещё вопрос",
	}, contents(h))
	assert.Equal(t, "t1", h.Turns[2].AnswerID)
	assert.Empty(t, h.LeadCode)
}

func TestSessionList(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	mk := func(id, mode string) {
		require.NoError(t, s.TouchSession(ctx, session.Ref{ID: id, Channel: session.Embed}, mode, "Вопрос "+id,
			session.RoleHint{}, session.LevelChoice{}))
		time.Sleep(3 * time.Millisecond)
	}
	mk("list-sess-001", "chat")
	mk("list-sess-002", "chat")
	mk("list-sess-003", "chat")
	mk("list-copilot", "copilot")
	require.NoError(t, s.SyncTurns(ctx, "list-sess-002", []dialog.Turn{u("q"), a("r"), u("q2")}))
	// Сессия старше 000009: переписки нет, есть строки журнала.
	_, err := s.Pool.Exec(ctx, `INSERT INTO answers (id, mode, question, answer, turns, session_id)
		VALUES ('old-1', 'chat', 'q', 'a', 1, 'list-sess-001')`)
	require.NoError(t, err)
	l := lead.Lead{Contacts: lead.Contacts{Name: "Тест", Phone: "+79000000000", Kind: lead.KindDemo},
		Summary: "s", SummarySource: lead.SummaryDigest, SessionID: "list-sess-002"}
	l.Code = "ccccccccc1"
	require.NoError(t, s.CreateLead(ctx, &l))

	page, err := s.SessionList(ctx, 2, 0)
	require.NoError(t, err)
	assert.Equal(t, 3, page.Total, "копилот в список не попадает")
	require.Len(t, page.Items, 2)
	assert.Equal(t, "list-sess-003", page.Items[0].ID, "новые сверху")
	assert.False(t, page.Items[0].HasLead)
	assert.Equal(t, "list-sess-002", page.Items[1].ID)
	assert.True(t, page.Items[1].HasLead)
	assert.Equal(t, "ccccccccc1", page.Items[1].LeadCode)
	assert.Equal(t, "demo", page.Items[1].LeadKind)
	assert.Equal(t, 3, page.Items[1].Messages)

	page, err = s.SessionList(ctx, 2, 2)
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	assert.Equal(t, "list-sess-001", page.Items[0].ID)
	assert.Equal(t, 2, page.Items[0].Messages, "старая сессия: вопрос и ответ из журнала")

	h, err := s.History(ctx, "list-sess-002")
	require.NoError(t, err)
	assert.Equal(t, "ccccccccc1", h.LeadCode)
	assert.Equal(t, "demo", h.LeadKind)
	h, err = s.History(ctx, "list-sess-001")
	require.NoError(t, err)
	assert.Equal(t, []string{"user: q", "assistant: a"}, contents(h), "старая сессия читается из журнала")
}

// Переписка — персональные данные: уходит вместе с сессией по сроку и по
// номеру телефона, упомянутому в реплике, а не только в заголовке.
func TestTranscriptPrivacy(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	for _, id := range []string{"priv-sess-old", "priv-sess-num", "priv-sess-ok"} {
		require.NoError(t, s.TouchSession(ctx, session.Ref{ID: id, Channel: session.Embed}, "chat", "АСКУЭ",
			session.RoleHint{}, session.LevelChoice{}))
	}
	require.NoError(t, s.SyncTurns(ctx, "priv-sess-old", []dialog.Turn{u("старый")}))
	require.NoError(t, s.SyncTurns(ctx, "priv-sess-num", []dialog.Turn{u("АСКУЭ"), a("ок"), u("мой номер 8 900 123 45 67")}))
	require.NoError(t, s.SyncTurns(ctx, "priv-sess-ok", []dialog.Turn{u("чужой")}))
	_, err := s.Pool.Exec(ctx, "UPDATE sessions SET updated_at = now() - interval '40 days' WHERE id = 'priv-sess-old'")
	require.NoError(t, err)
	count := func() (n int) {
		require.NoError(t, s.Pool.QueryRow(ctx, "SELECT count(*) FROM session_messages").Scan(&n))
		return n
	}
	require.Equal(t, 5, count())

	subj, err := privacy.NewSubject("+7 900 123 45 67", "")
	require.NoError(t, err)
	n, err := s.Forget(ctx, subj, true)
	require.NoError(t, err)
	assert.Equal(t, int64(1), n.Sessions)
	assert.Equal(t, 5, count(), "пробный прогон ничего не удаляет")
	_, err = s.Forget(ctx, subj, false)
	require.NoError(t, err)
	assert.Equal(t, 2, count(), "номер из реплики: сессия ушла вместе с перепиской")

	cut := privacy.Policy{Answers: 30 * 24 * time.Hour}.Cutoffs(time.Now())
	n, locked, err := s.Purge(ctx, cut)
	require.NoError(t, err)
	require.True(t, locked)
	assert.Equal(t, int64(1), n.Sessions)
	assert.Equal(t, 1, count(), "по сроку: переписка уходит с сессией")
}
