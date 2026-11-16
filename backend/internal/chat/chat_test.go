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

func TestSectionRefsSkipWeakSupport(t *testing.T) {
	// Живой ответ стенда: вопрос о складских счётчиках уверенно опирается на платформу учёта и слабо задевает
	// раздел о распознавании по фото — такой продукт в паспорт не попадает.
	var a Answer
	require.NoError(t, json.Unmarshal([]byte(`{"citations": [
		{"support": [{"id": "p1", "doc": "20-products/22-askue.md", "overlap": 0.62},
		             {"id": "r1", "doc": "20-products/25-meter-reading.md", "overlap": 0.4}]},
		{"support": [{"id": "r2", "doc": "20-products/25-meter-reading.md", "overlap": 0.5}]},
		{"question": true, "support": [{"id": "r3", "doc": "20-products/25-meter-reading.md", "overlap": 0.5}]}]}`), &a))
	refs := a.SectionRefs()
	require.Len(t, refs, 1)
	assert.Equal(t, "p1", refs[0].ID)
	assert.Equal(t, []string{"p1", "r1", "r2", "r3"}, a.Sources(), "журнал по-прежнему видит всю опору")
}
