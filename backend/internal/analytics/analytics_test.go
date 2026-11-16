package analytics

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseDays(t *testing.T) {
	n, err := ParseDays(0, false)
	require.NoError(t, err)
	assert.Equal(t, 7, n)
	n, err = ParseDays(30, true)
	require.NoError(t, err)
	assert.Equal(t, 30, n)
	for _, bad := range []int{0, 1, 14, 90, -7} {
		_, err = ParseDays(bad, true)
		assert.Error(t, err, bad)
	}
}

func TestBuildFunnelAndSlices(t *testing.T) {
	r := Build(7, Raw{Sessions: 20, Answered: 15, Filled: 5, WithLead: 2, Leads: 3,
		ByGrade: map[string]int{"hot": 1, "unscored": 2}, ByKind: map[string]int{"demo": 3},
		SessionsByChannel: map[string]int{"embed": 12}, LeadsByChannel: map[string]int{"embed": 3}}, nil)

	require.Len(t, r.Funnel, 4)
	assert.Equal(t, []int{20, 15, 5, 2}, []int{r.Funnel[0].Count, r.Funnel[1].Count, r.Funnel[2].Count, r.Funnel[3].Count})
	assert.InDelta(t, 0.75, r.Funnel[1].Share, 1e-9)
	assert.Equal(t, 3, r.MinFields)
	assert.Equal(t, "Горячая", r.ByGrade[0].Label)
	assert.Equal(t, 2, r.ByGrade[3].Count, "заявки без оценки — отдельная строка")
	require.Len(t, r.ByKind, 4, "все типы заявки, даже с нулём")
	assert.Equal(t, 3, r.ByKind[2].Count)
	assert.Equal(t, Channel{"embed", "Виджет", 12, 3}, r.ByChannel[1])
	assert.NotNil(t, r.Gaps, "пустой список, а не null")
}

func TestBuildEmptyPeriod(t *testing.T) {
	r := Build(30, Raw{}, nil)
	for _, s := range r.Funnel {
		assert.Zero(t, s.Count)
		assert.Zero(t, s.Share, "без сессий доли нет, а не деления на ноль")
	}
}
