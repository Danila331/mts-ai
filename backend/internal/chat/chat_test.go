package chat

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStripDebug(t *testing.T) {
	in := json.RawMessage(`{"id":"a","text":"т","prompt":[1],"prompt_chars":1,"retrieval":{},"llm_calls":[],"trace":"x","citations":[]}`)
	var out map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(StripDebug(in), &out))
	assert.ElementsMatch(t, []string{"id", "text", "citations"}, keys(out))

	assert.Equal(t, json.RawMessage(`[1]`), StripDebug(json.RawMessage(`[1]`)), "не объект — как есть")
	assert.Equal(t, json.RawMessage(`oops`), StripDebug(json.RawMessage(`oops`)))
}

func TestPublicChannel(t *testing.T) {
	assert.True(t, PublicChannel("embed"))
	assert.True(t, PublicChannel("telegram"))
	assert.False(t, PublicChannel("playground"))
	assert.False(t, PublicChannel(""))
}

func keys(m map[string]json.RawMessage) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestConversationStatsRates(t *testing.T) {
	s := ConversationStats{Answers: 4, Answered: 3, NoBoundary: 4, Sessions: 2, LeadSessions: 1}
	s.Rates()
	assert.InDelta(t, 0.75, s.AnsweredRate, 1e-9)
	assert.InDelta(t, 1.0, s.NoBoundaryRate, 1e-9)
	assert.InDelta(t, 0.5, s.LeadConversion, 1e-9)
	var empty ConversationStats
	empty.Rates()
	assert.Zero(t, empty.LeadConversion, "без диалогов — ноль, а не деление на ноль")
}
