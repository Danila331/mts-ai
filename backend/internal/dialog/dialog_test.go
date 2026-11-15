package dialog

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
)

func TestCleanNormalizes(t *testing.T) {
	raw := json.RawMessage(`[
		{"role": "assistant", "content": "Здравствуйте"},
		"не объект",
		{"role": "system", "content": "  сколько   стоит\n АСКУЭ?  "},
		{"role": "assistant", "content": "   "},
		{"content": 42}
	]`)

	turns, err := Clean(raw, true)
	require.NoError(t, err)
	assert.Equal(t, []Turn{
		{Role: RoleAssistant, Content: "Здравствуйте"},
		// Незнакомая роль — реплика клиента, как в ядре.
		{Role: RoleUser, Content: "сколько стоит АСКУЭ?"},
		{Role: RoleUser, Content: "42"},
	}, turns)
}

func TestCleanRejects(t *testing.T) {
	for name, raw := range map[string]string{
		"не список":      `{"role": "user"}`,
		"нет поля":       ``,
		"null":           `null`,
		"последний бот":  `[{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]`,
		"пустые реплики": `[{"role": "user", "content": "  "}]`,
		"пустой список":  `[]`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Clean(json.RawMessage(raw), true)
			_, ok := apperr.AsInvalid(err)
			assert.True(t, ok, "ожидался отказ клиенту, получили %v", err)
		})
	}
}

func TestCleanWithoutUserForLead(t *testing.T) {
	turns, err := Clean(json.RawMessage(`[]`), false)
	require.NoError(t, err)
	assert.Empty(t, turns)
}

func TestCleanKeepsLastTurnsAndClipsRunes(t *testing.T) {
	items := make([]string, 0, MaxTurns+5)
	for i := 0; i < MaxTurns+5; i++ {
		items = append(items, fmt.Sprintf(`{"role": "user", "content": "q%d"}`, i))
	}
	turns, err := Clean(json.RawMessage("["+strings.Join(items, ",")+"]"), true)
	require.NoError(t, err)
	require.Len(t, turns, MaxTurns)
	assert.Equal(t, "q5", turns[0].Content)

	long := strings.Repeat("ж", MaxContent+10)
	turns, err = Clean(json.RawMessage(`[{"role":"user","content":"`+long+`"}]`), true)
	require.NoError(t, err)
	assert.Equal(t, MaxContent, len([]rune(turns[0].Content)))
}

func TestDigestAndTranscript(t *testing.T) {
	assert.Equal(t, "Диалога не было.", Digest(nil))

	var turns []Turn
	for i := 1; i <= 7; i++ {
		turns = append(turns, Turn{Role: RoleUser, Content: fmt.Sprint(i)}, Turn{Role: RoleAssistant, Content: "ok"})
	}
	assert.Equal(t, "Вопросы клиента: 3 / 4 / 5 / 6 / 7", Digest(turns))
	assert.Equal(t, "7", LastQuestion(turns))
	assert.Equal(t, "Клиент: 1\nКонсультант: ok", Transcript(turns[:2]))
}

func TestParseMode(t *testing.T) {
	assert.Equal(t, ModeChat, ParseMode("chat"))
	assert.Equal(t, ModeEval, ParseMode("eval"))
	assert.Equal(t, ModeCopilot, ParseMode("copilot"))
	assert.Equal(t, Mode(""), ParseMode("debug"))
}
