package core

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
)

func TestStreamParsesEvents(t *testing.T) {
	long := strings.Repeat("а", 200_000) // длиннее любого буфера по умолчанию
	body := ": комментарий\n\n" +
		"event: stage\ndata: {\"name\": \"retrieval\"}\n\n" +
		"event: answer\r\ndata: {\"id\": \"x\", \"text\": \"" + long + "\"}\r\n\r\n" +
		"event: done\ndata: {}\n\n"
	s := newStream(io.NopCloser(strings.NewReader(body)))

	ev, err := s.Next()
	require.NoError(t, err)
	assert.Equal(t, "stage", ev.Name)
	assert.JSONEq(t, `{"name": "retrieval"}`, string(ev.Data))

	ev, err = s.Next()
	require.NoError(t, err)
	assert.Equal(t, "answer", ev.Name)
	var a chat.Answer
	require.NoError(t, json.Unmarshal(ev.Data, &a))
	assert.Len(t, []rune(a.Text), 200_000)

	ev, err = s.Next()
	require.NoError(t, err)
	assert.Equal(t, "done", ev.Name)

	_, err = s.Next()
	assert.ErrorIs(t, err, io.EOF)
}

func TestStreamReportsCutEvent(t *testing.T) {
	s := newStream(io.NopCloser(strings.NewReader("event: answer\ndata: {\"id\"")))
	_, err := s.Next()
	require.Error(t, err)
	assert.False(t, errors.Is(err, io.EOF), "оборванное событие — не конец потока")
}

func TestClientSendsTokenAndTurns(t *testing.T) {
	var got struct {
		Messages []dialog.Turn `json:"messages"`
		Mode     string        `json:"mode"`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/core/chat":
			_ = json.NewDecoder(r.Body).Decode(&got)
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: done\ndata: {}\n\n")
		case "/core/health":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error": "плохой запрос"}`)
		}
	}))
	defer srv.Close()

	c := New(srv.URL+"/", "secret")
	turns := []dialog.Turn{{Role: dialog.RoleUser, Content: "привет"}}
	st, err := c.Chat(context.Background(), chat.Request{Turns: turns, Mode: dialog.ModeEval})
	require.NoError(t, err)
	ev, err := st.Next()
	require.NoError(t, err)
	assert.Equal(t, "done", ev.Name)
	require.NoError(t, st.Close())
	assert.Equal(t, turns, got.Messages)
	assert.Equal(t, "eval", got.Mode)

	_, err = c.Health(context.Background())
	var coreErr *Error
	require.ErrorAs(t, err, &coreErr)
	assert.Equal(t, http.StatusBadRequest, coreErr.Status)
	assert.Equal(t, "плохой запрос", coreErr.Msg)

	_, err = New(srv.URL, "wrong").KB(context.Background())
	require.ErrorAs(t, err, &coreErr)
	assert.Equal(t, http.StatusUnauthorized, coreErr.Status)
}

func TestClientUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	srv.Close()
	_, err := New(srv.URL, "").Chat(context.Background(), chat.Request{})
	assert.ErrorIs(t, err, ErrUnavailable)
}
