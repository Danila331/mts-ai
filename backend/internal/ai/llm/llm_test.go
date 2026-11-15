package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStripThinking(t *testing.T) {
	assert.Equal(t, "ответ", StripThinking("<think>думаю</think>\n ответ "))
	assert.Equal(t, "ответ", StripThinking("думаю без открывающей</think>ответ"))
	assert.Equal(t, "", StripThinking("<think>не успел"))
	assert.Equal(t, "до", StripThinking("до<think>не успел"))
	assert.Equal(t, "чисто", StripThinking("чисто"))
}

func TestChatDropsUnknownThinkingParam(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		assert.Equal(t, "Bearer key", r.Header.Get("Authorization"))
		if _, ok := body["chat_template_kwargs"]; ok {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error": "unknown field chat_template_kwargs"}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices": [{"message": {"content": "<think>x</think>Резюме"}}]}`))
	}))
	defer srv.Close()

	c := New(Options{BaseURL: srv.URL + "/", APIKey: "key", Model: "m",
		ThinkingParam: "chat_template_kwargs", DisableThinking: true})
	text, err := c.Chat(context.Background(), []Message{{Role: "user", Content: "hi"}}, 100)
	require.NoError(t, err)
	assert.Equal(t, "Резюме", text)
	assert.Equal(t, int32(2), calls.Load())
}

func TestChatRetriesOverload(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte(`{"choices": [{"message": {"content": "ok"}}]}`))
	}))
	defer srv.Close()

	c := New(Options{BaseURL: srv.URL, APIKey: "key", ThinkingParam: "none", DisableThinking: true})
	text, err := c.Chat(context.Background(), nil, 10)
	require.NoError(t, err)
	assert.Equal(t, "ok", text)
	assert.Equal(t, int32(2), calls.Load())
}

func TestChatNotConfigured(t *testing.T) {
	_, err := New(Options{}).Chat(context.Background(), nil, 10)
	assert.ErrorIs(t, err, ErrNotConfigured)
}

func TestClipKeepsRunes(t *testing.T) {
	assert.Equal(t, "ab", clip("ab", 5))
	// «я» — два байта: три байта режутся до целой буквы, а не до половины.
	assert.Equal(t, "я", clip("яя", 3))
}
