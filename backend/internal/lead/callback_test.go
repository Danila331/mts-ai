package lead

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// promise — обещания, которых база не разрешает: точное время, срок
// звонка, имя специалиста (раздел «Обратный звонок»). Общий для тестов
// текстов заявки.
var promise = regexp.MustCompile(`(?i:\d{1,2}[:.]\d{2}|через \d+|\d+\s*(мин|час)|в течение|сегодня|завтра|` +
	`перезвоним в|позвоним в|до конца (дня|недели))|(?:[Сс]пециалист|[Мм]енеджер)\s+[А-ЯЁ][а-яё]+`)

func TestCallbackNormalize(t *testing.T) {
	for _, tc := range []struct {
		in    Callback
		want  Callback
		label string
	}{
		{Callback{Time: "morning", Timezone: "Europe/Moscow"}, Callback{Time: "morning", Timezone: "Europe/Moscow"},
			"утро, часовой пояс Europe/Moscow"},
		{Callback{Time: " evening ", Timezone: "Asia/Yekaterinburg"}, Callback{Time: "evening", Timezone: "Asia/Yekaterinburg"},
			"вечер, часовой пояс Asia/Yekaterinburg"},
		{Callback{Time: "any"}, Callback{Time: "any"}, "любое время"},
		{Callback{Time: "day", Timezone: "<script>"}, Callback{Time: "day"}, "день"},
		{Callback{Time: "day", Timezone: strings.Repeat("A", 80)}, Callback{Time: "day"}, "день"},
		{Callback{}, Callback{}, ""},
	} {
		got, err := tc.in.Normalize()
		require.NoError(t, err, tc.in)
		assert.Equal(t, tc.want, got)
		assert.Equal(t, tc.label, got.Label())
	}
	_, err := Callback{Time: "15:00"}.Normalize()
	assert.Error(t, err, "точное время — не вариант выбора")
}

// T4: база запрещает обещать точное время звонка и имя специалиста.
func TestCallbackTextsPromiseNothing(t *testing.T) {
	raw, err := os.ReadFile("../../../knowledge-base/00-reference/03-calculation-and-requests.md")
	require.NoError(t, err)
	kb := strings.Join(strings.Fields(string(raw)), " ")
	assert.Contains(t, kb, "## Обратный звонок")
	assert.Contains(t, kb, "Нельзя обещать точное время звонка, имя специалиста или заранее определённое содержание разговора")

	texts := []string{SummarySystem}
	for _, c := range CallbackTimes {
		texts = append(texts, c.Label, Callback{Time: c.Value, Timezone: "Europe/Moscow"}.Label())
	}
	_, err = Callback{Time: "x"}.Normalize()
	texts = append(texts, err.Error())
	for _, s := range texts {
		assert.False(t, promise.MatchString(s), "обещание в тексте: %q → %q", s, promise.FindString(s))
	}
	for _, bad := range []string{"Перезвоним в 15:00", "через 5 минут", "Вам позвонит менеджер Анна", "сегодня до конца дня"} {
		assert.True(t, promise.MatchString(bad), bad)
	}
	for _, ok := range []string{"Менеджер учтёт удобное время", "Менеджер МТС свяжется с вами"} {
		assert.False(t, promise.MatchString(ok), ok)
	}
}
