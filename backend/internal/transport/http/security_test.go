package http

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/config"
)

// Тесты T35: защита виджета, формы заявки и пределов.

const debugStream = "event: stage\ndata: {\"name\": \"retrieval\"}\n\n" +
	"event: answer\ndata: {\"id\": \"a1\", \"text\": \"Ответ\", \"mode\": \"chat\", \"fallback\": false," +
	" \"prompt\": [{\"role\": \"system\", \"content\": \"СЕКРЕТНЫЕ ПРАВИЛА\"}], \"prompt_chars\": 17," +
	" \"retrieval\": {\"hits\": [{\"id\": \"x\"}]}, \"llm_calls\": [{\"ms\": 1}], \"trace\": \"разбор\"," +
	" \"citations\": [], \"timings\": {\"total\": 5}}\n\n" +
	"event: done\ndata: {}\n\n"

func answerOf(t *testing.T, body string) map[string]json.RawMessage {
	t.Helper()
	for _, e := range readSSE(t, body) {
		if e.name == "answer" {
			var m map[string]json.RawMessage
			require.NoError(t, json.Unmarshal([]byte(e.data), &m))
			return m
		}
	}
	t.Fatal("в потоке нет события answer")
	return nil
}

func TestEmbedAnswerHasNoDebugFields(t *testing.T) {
	s, store := newServer(t, fakeCore(t, debugStream).URL, nil)
	req := func(channel string) map[string]json.RawMessage {
		rec := do(s, http.MethodPost, "/api/chat",
			`{"messages": [{"role": "user", "content": "q"}], "channel": "`+channel+`", "session_id": "sess-12345678"}`)
		require.Equal(t, http.StatusOK, rec.Code)
		return answerOf(t, rec.Body.String())
	}

	embed := req("embed")
	for _, k := range []string{"prompt", "prompt_chars", "retrieval", "llm_calls", "trace"} {
		assert.NotContains(t, embed, k, "виджет не получает поле %s", k)
	}
	for _, k := range []string{"id", "text", "citations", "timings", "fallback"} {
		assert.Contains(t, embed, k, "поле %s нужно виджету", k)
	}

	stand := req("playground")
	assert.Contains(t, stand, "prompt", "стенд разработчика видит промпт, как раньше")
	assert.Contains(t, stand, "llm_calls")

	// Журнал пишется из полного ответа ядра: вырезание только на выходе к клиенту.
	require.Equal(t, 2, store.answerCount())
	assert.Equal(t, "a1", store.answers[0].ID)
}

func TestLeadHoneypotAndMinFill(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) {
		c.Limits.LeadMinFill = 2 * time.Second
	})
	form := func(extra string) string {
		return `{"name": "Иван", "phone": "+7 900 000-00-00", "consent": true, ` + extra +
			`"messages": [{"role": "user", "content": "Нужен АСКУЭ"}]}`
	}

	rec := do(s, http.MethodPost, "/api/lead", form(`"website": "http://spam.example", "elapsed_ms": 9000, `))
	assert.Equal(t, http.StatusBadRequest, rec.Code, "ловушка заполнена — это не человек")
	assert.NotContains(t, rec.Body.String(), "бот", "текст без обвинений")

	rec = do(s, http.MethodPost, "/api/lead", form(`"elapsed_ms": 300, `))
	assert.Equal(t, http.StatusBadRequest, rec.Code, "форма заполнена за 0,3 с")
	assert.Contains(t, rec.Body.String(), "ещё раз")

	rec = do(s, http.MethodPost, "/api/lead", form(""))
	assert.Equal(t, http.StatusBadRequest, rec.Code, "без времени заполнения — как слишком быстро")
	assert.Empty(t, store.leads, "отклонённые заявки не сохраняются")

	rec = do(s, http.MethodPost, "/api/lead", form(`"website": "", "elapsed_ms": 4500, `))
	assert.Equal(t, http.StatusOK, rec.Code, "человек: поле пустое, прошло 4,5 с")
	assert.Len(t, store.leads, 1)
}

func TestCheckHuman(t *testing.T) {
	ms := func(v int64) *int64 { return &v }
	min := 2 * time.Second
	assert.Empty(t, checkHuman("", ms(2000), min), "ровно предел — можно")
	assert.NotEmpty(t, checkHuman("", ms(1999), min))
	assert.NotEmpty(t, checkHuman("", nil, min))
	assert.NotEmpty(t, checkHuman("x", ms(5000), min))
	assert.Empty(t, checkHuman("", nil, 0), "ноль выключает проверку времени")
	assert.NotEmpty(t, checkHuman("x", nil, 0), "а ловушку — нет")
	for _, m := range []string{msgTooFast, msgHoneypot} {
		low := strings.ToLower(m)
		assert.NotContains(t, low, "немедленно")
		assert.NotContains(t, low, "срочно")
	}
}

func TestChatDailyCap(t *testing.T) {
	s, _ := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) {
		c.Limits.ChatPerDay = 2
	})
	body := `{"messages": [{"role": "user", "content": "q"}]}`
	assert.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/chat", body).Code)
	assert.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/chat", body).Code)
	rec := do(s, http.MethodPost, "/api/chat", body)
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Contains(t, rec.Body.String(), "лимит")
}

func TestClientIPNeedsTokenAndRealAddress(t *testing.T) {
	s, _ := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) {
		c.HTTP.Token = "front-token"
		c.Limits.FeedbackPerMinute, c.Limits.FeedbackBurst = 1, 1
	})
	body := `{"message_id": "m", "rating": 1}`
	auth := []string{"Authorization", "Bearer front-token"}

	// Подставной X-Forwarded-For не даёт нового адреса: пределом правит X-Client-IP прокси.
	first := append(append([]string{}, auth...), "X-Client-IP", "1.1.1.1", "X-Forwarded-For", "9.9.9.9")
	assert.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/feedback", body, first...).Code)
	spoof := append(append([]string{}, auth...), "X-Client-IP", "1.1.1.1", "X-Forwarded-For", "8.8.8.8")
	assert.Equal(t, http.StatusTooManyRequests, do(s, http.MethodPost, "/api/feedback", body, spoof...).Code,
		"смена X-Forwarded-For обходом предела не стала")

	// Мусор вместо адреса не становится ключом предела.
	junk := append(append([]string{}, auth...), "X-Client-IP", "<script>")
	assert.Equal(t, http.StatusOK, do(s, http.MethodPost, "/api/feedback", body, junk...).Code)
	assert.Equal(t, http.StatusTooManyRequests, do(s, http.MethodPost, "/api/feedback", body, junk...).Code,
		"мусор отброшен: берётся адрес соединения")
}

func TestParseIP(t *testing.T) {
	assert.Equal(t, "203.0.113.7", parseIP(" 203.0.113.7 "))
	assert.Equal(t, "2001:db8::1", parseIP("2001:db8::1"))
	assert.Equal(t, "203.0.113.7", parseIP("::ffff:203.0.113.7"))
	for _, bad := range []string{"", "x", "1.2.3", "1.1.1.1, 2.2.2.2", "<script>"} {
		assert.Empty(t, parseIP(bad), bad)
	}
}
