package core

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
)

func TestBreakerOpensAndCloses(t *testing.T) {
	now := time.Now()
	b := NewBreaker(3, 10*time.Second)
	b.now = func() time.Time { return now }

	for i := 0; i < 2; i++ {
		require.NoError(t, b.Allow())
		b.Done(false)
	}
	require.NoError(t, b.Allow(), "две неудачи из трёх — ещё замкнут")
	b.Done(false)

	assert.ErrorIs(t, b.Allow(), ErrCircuitOpen, "три подряд — разомкнут")
	assert.ErrorIs(t, ErrCircuitOpen, ErrUnavailable)
	assert.True(t, b.Open())

	now = now.Add(11 * time.Second)
	require.NoError(t, b.Allow(), "после паузы — одна проба")
	assert.ErrorIs(t, b.Allow(), ErrCircuitOpen, "пока проба в пути, остальные ждут")
	b.Done(false)
	assert.ErrorIs(t, b.Allow(), ErrCircuitOpen, "неудачная проба размыкает снова")

	now = now.Add(11 * time.Second)
	require.NoError(t, b.Allow())
	b.Done(true)
	require.NoError(t, b.Allow(), "успешная проба замыкает")
	assert.False(t, b.Open())
}

func TestBreakerDisabled(t *testing.T) {
	b := NewBreaker(0, time.Second)
	for i := 0; i < 10; i++ {
		require.NoError(t, b.Allow())
		b.Done(false)
	}
	var nilBreaker *Breaker
	require.NoError(t, nilBreaker.Allow())
}

func chatReq() chat.Request {
	return chat.Request{Turns: []dialog.Turn{{Role: dialog.RoleUser, Content: "привет"}}, Mode: dialog.ModeChat}
}

func TestClientBreakerOnDeadCore(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	c := New(srv.URL, "").WithBreaker(2, time.Hour).WithRetries(1)
	c.retryPause = time.Millisecond

	for i := 0; i < 2; i++ {
		_, err := c.Chat(context.Background(), chatReq())
		var ce *Error
		require.ErrorAs(t, err, &ce)
	}
	assert.EqualValues(t, 4, hits.Load(), "каждый вызов: попытка и один повтор")

	_, err := c.Chat(context.Background(), chatReq())
	assert.ErrorIs(t, err, ErrCircuitOpen)
	_, err = c.Health(context.Background())
	assert.ErrorIs(t, err, ErrCircuitOpen, "и состояние ядра не ходит к лежащему ядру")
	assert.EqualValues(t, 4, hits.Load(), "разомкнутый предохранитель до ядра не доходит")
	assert.True(t, c.Degraded())
}

func TestClientRetriesBeforeFirstByteOnly(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: done\ndata: {}\n\n"))
	}))
	t.Cleanup(srv.Close)

	c := New(srv.URL, "").WithBreaker(2, time.Hour).WithRetries(1)
	c.retryPause = time.Millisecond
	s, err := c.Chat(context.Background(), chatReq())
	require.NoError(t, err, "второй заход открыл поток")
	_ = s.Close()
	assert.EqualValues(t, 2, hits.Load())
	assert.False(t, c.Degraded(), "успех не копит неудачи")
}

func TestClientClientErrorDoesNotTripBreaker(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error": "плохой запрос"}`))
	}))
	t.Cleanup(srv.Close)

	c := New(srv.URL, "").WithBreaker(1, time.Hour).WithRetries(2)
	c.retryPause = time.Millisecond
	for i := 0; i < 3; i++ {
		_, err := c.Chat(context.Background(), chatReq())
		var ce *Error
		require.ErrorAs(t, err, &ce)
	}
	assert.EqualValues(t, 3, hits.Load(), "4xx не повторяется и предохранитель не трогает")
	assert.False(t, c.Degraded())
}

func TestClientRecoversAfterCooldown(t *testing.T) {
	var down atomic.Bool
	down.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if down.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"ok": true}`))
	}))
	t.Cleanup(srv.Close)

	c := New(srv.URL, "").WithBreaker(1, 30*time.Millisecond)
	_, err := c.Health(context.Background())
	require.Error(t, err)
	_, err = c.Health(context.Background())
	require.ErrorIs(t, err, ErrCircuitOpen)

	down.Store(false)
	time.Sleep(50 * time.Millisecond)
	_, err = c.Health(context.Background())
	require.NoError(t, err, "проба после паузы прошла")
	assert.False(t, c.Degraded())
}
