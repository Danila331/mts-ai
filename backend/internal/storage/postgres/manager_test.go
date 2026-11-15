package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

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
