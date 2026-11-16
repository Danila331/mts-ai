package lead

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/passport"
)

func TestKindsQuoteKnowledgeBase(t *testing.T) {
	for _, k := range Kinds {
		raw, err := os.ReadFile(filepath.Join("../../../knowledge-base", k.Doc))
		require.NoError(t, err)
		md := string(raw)
		head := regexp.MustCompile(`(?m)^#{2,3} ` + regexp.QuoteMeta(k.Section) + `\s*$`).FindStringIndex(md)
		require.NotNil(t, head, "%s: нет раздела «%s»", k.Doc, k.Section)
		rest := md[head[1]:]
		if next := regexp.MustCompile(`(?m)^#{1,3} `).FindStringIndex(rest); next != nil {
			rest = rest[:next[0]]
		}
		assert.Contains(t, strings.Join(strings.Fields(rest), " "), k.Quote, "%s: %s", k.Kind, k.Section)
		assert.False(t, promise.MatchString(k.Label), k.Label)
	}
	// Демо и пилот — только платформа учёта: так в базе («Можно ли сначала посмотреть», 26-general.md).
	raw, err := os.ReadFile("../../../knowledge-base/20-products/26-general.md")
	require.NoError(t, err)
	assert.Contains(t, strings.Join(strings.Fields(string(raw)), " "),
		"По платформе учёта доступен демонстрационный доступ по запросу и пилотное подключение части приборов")
}

func TestKindsFor(t *testing.T) {
	cand := func(gs ...passport.Group) []passport.Candidate {
		var out []passport.Candidate
		for _, g := range gs {
			out = append(out, passport.Candidate{Product: g})
		}
		return out
	}
	assert.Equal(t, []Kind{KindCallback, KindAssessment}, KindsFor(cand(passport.Solar)), "солнце — без демо и пилота")
	assert.Equal(t, []Kind{KindCallback, KindAssessment}, KindsFor(nil), "продукт неизвестен")
	assert.Equal(t, []Kind{KindCallback, KindAssessment, KindDemo, KindPilot}, KindsFor(cand(passport.Platform)))
	assert.Equal(t, []Kind{KindCallback, KindAssessment, KindDemo, KindPilot}, KindsFor(cand(passport.Wholesale, passport.Platform)),
		"платформу обсуждали не первой — всё равно годится")

	k, err := ParseKind("")
	require.NoError(t, err)
	assert.Equal(t, KindCallback, k)
	_, err = ParseKind("meeting")
	assert.Error(t, err, "встречи на время нет — база запрещает обещать время")
}
