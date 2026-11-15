package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/analytics"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/lead/score"
	"github.com/Danila331/mts-ai/backend/internal/passport"
)

// Экран менеджера (T5) против живой базы: CHECK статуса, порядок списка,
// оценка из jsonb.
func TestLeadBoard(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()

	hot := lead.Lead{Code: "hot0000001", Contacts: lead.Contacts{Name: "Тестов Тест Тестович", Phone: "+79000000000",
		Company: "ООО Учебный склад", Kind: lead.KindDemo, Callback: lead.Callback{Time: "evening", Timezone: "Europe/Moscow"}},
		Summary: "s", SessionID: "sess-board-1",
		Score: score.Score{Grade: score.Hot, Product: passport.Platform, Reasons: []string{"Подходит"}, Missing: []string{"Схема сбора"}}}
	require.NoError(t, s.CreateLead(ctx, &hot))
	time.Sleep(5 * time.Millisecond)
	old := lead.Lead{Code: "old0000001", Summary: "s"} // без оценки, как до T3
	require.NoError(t, s.CreateLead(ctx, &old))

	t.Run("список: новые сверху, статус new", func(t *testing.T) {
		page, err := s.LeadList(ctx, "", 10, 0)
		require.NoError(t, err)
		require.Equal(t, 2, page.Total)
		assert.Equal(t, "old0000001", page.Items[0].Code)
		assert.Equal(t, lead.StatusNew, page.Items[0].Status)
		assert.Equal(t, score.Grade(""), page.Items[0].Grade, "заявка без оценки")
		assert.Equal(t, "hot0000001", page.Items[1].Code)
		assert.Equal(t, score.Hot, page.Items[1].Grade)
		assert.Equal(t, passport.Platform, page.Items[1].Product)
		assert.Equal(t, lead.KindDemo, page.Items[1].Kind)

		page, err = s.LeadList(ctx, "", 1, 1)
		require.NoError(t, err)
		require.Len(t, page.Items, 1)
		assert.Equal(t, "hot0000001", page.Items[0].Code)
		assert.Equal(t, 2, page.Total)
	})

	t.Run("карточка", func(t *testing.T) {
		c, err := s.LeadCard(ctx, "hot0000001")
		require.NoError(t, err)
		assert.Equal(t, "sess-board-1", c.SessionID)
		assert.Equal(t, []string{"Схема сбора"}, c.Score.Missing)
		assert.Equal(t, "вечер, часовой пояс Europe/Moscow", c.CallbackLabel)
		assert.Equal(t, "Платформа учёта", c.ProductLabel)
		assert.Nil(t, c.StatusChanged)

		_, err = s.LeadCard(ctx, "nope")
		assert.ErrorIs(t, err, lead.ErrNotFound)
	})

	t.Run("статус", func(t *testing.T) {
		require.NoError(t, s.SetLeadStatus(ctx, "hot0000001", lead.StatusInProgress))
		c, err := s.LeadCard(ctx, "hot0000001")
		require.NoError(t, err)
		assert.Equal(t, lead.StatusInProgress, c.Status)
		require.NotNil(t, c.StatusChanged)

		page, err := s.LeadList(ctx, lead.StatusInProgress, 10, 0)
		require.NoError(t, err)
		assert.Equal(t, 1, page.Total)
		assert.Equal(t, "hot0000001", page.Items[0].Code)

		assert.ErrorIs(t, s.SetLeadStatus(ctx, "nope", lead.StatusDone), lead.ErrNotFound)
		// Базу от мусорного статуса держит CHECK, а не только код.
		_, err = s.Pool.Exec(ctx, "UPDATE leads SET status = 'wow' WHERE code = 'hot0000001'")
		assert.Error(t, err)
	})
}

// Аналитика (T6) против живой базы: воронка, срезы, пробелы без ПДн.
func TestAnalytics(t *testing.T) {
	s := openTest(t)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := s.Pool.Exec(ctx, sql, args...)
		require.NoError(t, err)
	}

	// Три сессии: стенд без ответа, виджет с ответом, виджет с паспортом и заявкой.
	exec(`INSERT INTO sessions (id, channel, passport) VALUES
	        ('sess-empty-1', 'playground', '{}'),
	        ('sess-asked-1', 'embed', '{"values":{"org_type":{"value":"склад"}}}'),
	        ('sess-lead-01', 'embed', '{"values":{"org_type":{"value":"склад"},"region":{"value":"Тверская"},"task":{"value":"учёт"},
	                                     "name":{"value":"Тестов"},"phone":{"value":"+79000000000"}}}')`)
	// Контакты в паспорте не считаются: у sess-asked-1 одно поле, у sess-lead-01 три и два контакта.
	exec(`INSERT INTO answers (id, mode, question, answer, fallback, turns, session_id, created_at) VALUES
	        ('an-1', 'chat', 'Что такое АСКУЭ?', 'Платформа', false, 1, 'sess-asked-1', now()),
	        ('an-2', 'chat', 'Звоните 8 (900) 123-45-67 или test@example.com, сколько стоит?', 'Нет в базе', true, 1, 'sess-lead-01', now()),
	        ('an-3', 'chat', 'Звоните 8 (900) 123-45-67 или test@example.com, сколько стоит?', 'Нет в базе', true, 1, NULL, now()),
	        ('an-old', 'chat', 'Старый вопрос', 'Нет', true, 1, NULL, now() - interval '40 days')`)
	l := lead.Lead{Code: "an-lead-001", Contacts: lead.Contacts{Name: "Тестов Тест Тестович", Kind: lead.KindAssessment},
		Summary: "s", SessionID: "sess-lead-01", Score: score.Score{Grade: score.Hot, Product: passport.Platform}}
	require.NoError(t, s.CreateLead(ctx, &l))
	old := lead.Lead{Code: "an-lead-002", Summary: "s"}
	require.NoError(t, s.CreateLead(ctx, &old))

	r, err := s.Analytics(ctx, 7)
	require.NoError(t, err)
	assert.Equal(t, []int{3, 2, 1, 1}, []int{r.Funnel[0].Count, r.Funnel[1].Count, r.Funnel[2].Count, r.Funnel[3].Count},
		"сессии → с ответом → паспорт от 3 полей → с заявкой")
	assert.Equal(t, 2, r.Leads, "обе заявки свежие")
	assert.Equal(t, 1, r.ByGrade[0].Count, "горячих")
	assert.Equal(t, 1, r.ByGrade[3].Count, "без оценки")
	assert.Equal(t, 1, r.ByKind[1].Count, "предварительная оценка")
	assert.Equal(t, 1, r.ByKind[0].Count, "обратный звонок по умолчанию")
	assert.Equal(t, analytics.Channel{Key: "embed", Label: "Виджет", Sessions: 2, Leads: 1}, r.ByChannel[1])
	assert.Equal(t, 1, r.ByChannel[3].Leads, "заявка без сессии — «без сессии»")
	assert.Equal(t, 3, r.Answers)
	assert.Equal(t, 2, r.Fallbacks, "старый ответ вне периода")

	require.Len(t, r.Gaps, 1, "одинаковые вопросы сгруппированы")
	assert.Equal(t, 2, r.Gaps[0].Count)
	assert.Equal(t, "Звоните [телефон] или [почта], сколько стоит?", r.Gaps[0].Question, "ПДн замаскированы")

	r30, err := s.Analytics(ctx, 30)
	require.NoError(t, err)
	assert.Equal(t, 2, r30.Fallbacks)
}
