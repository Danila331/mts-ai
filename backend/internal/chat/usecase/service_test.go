package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/requestid"
	"github.com/Danila331/mts-ai/backend/internal/session"
)

// script — поток ядра из готовых событий; err — чем он кончится.
type script struct {
	events []chat.Event
	err    error
	closed bool
}

func (s *script) Next() (chat.Event, error) {
	if len(s.events) == 0 {
		if s.err != nil {
			return chat.Event{}, s.err
		}
		return chat.Event{}, io.EOF
	}
	ev := s.events[0]
	s.events = s.events[1:]
	return ev, nil
}

func (s *script) Close() error { s.closed = true; return nil }

type fakeCore struct {
	stream *script
	err    error
	ctx    context.Context
}

func (c *fakeCore) Chat(ctx context.Context, _ chat.Request) (chat.Stream, error) {
	c.ctx = ctx
	if c.err != nil {
		return nil, c.err
	}
	return c.stream, nil
}

type journal struct {
	mu       sync.Mutex
	recs     []chat.Record
	sessions []string
	err      error
}

func (j *journal) TouchSession(_ context.Context, ref session.Ref, _, title string) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.sessions = append(j.sessions, ref.ID+"|"+string(ref.Channel)+"|"+title)
	return j.err
}

func (j *journal) SaveAnswer(_ context.Context, r chat.Record) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.recs = append(j.recs, r)
	return j.err
}

func ev(name, data string) chat.Event { return chat.Event{Name: name, Data: json.RawMessage(data)} }

var req = chat.Request{Turns: []dialog.Turn{{Role: dialog.RoleUser, Content: "Что такое АСКУЭ?"}}, Mode: dialog.ModeChat}

func forward(t *testing.T, st *script, j *journal, emit func(chat.Event) error) ([]string, chat.Outcome) {
	t.Helper()
	ctx := requestid.With(context.Background(), "req-1")
	relay, err := New(&fakeCore{stream: st}, j, time.Minute).Ask(ctx, req)
	require.NoError(t, err)
	var got []string
	outcome := relay.Forward(func(e chat.Event) error {
		got = append(got, e.Name)
		if emit != nil {
			return emit(e)
		}
		return nil
	})
	assert.True(t, st.closed, "поток ядра закрывается всегда")
	return got, outcome
}

func TestForwardAnswered(t *testing.T) {
	j := &journal{}
	got, outcome := forward(t, &script{events: []chat.Event{
		ev("stage", `{"name":"retrieval"}`), ev("answer", `{"id":"a1","text":"Ответ"}`), ev("done", `{}`),
	}}, j, nil)

	assert.Equal(t, []string{"stage", "answer", "done"}, got)
	assert.Equal(t, chat.OutcomeAnswered, outcome)
	require.Len(t, j.recs, 1)
	assert.Equal(t, "a1", j.recs[0].ID)
	assert.Equal(t, "Что такое АСКУЭ?", j.recs[0].Question)
	assert.Equal(t, "chat", j.recs[0].Mode, "режим запроса, если ядро его не назвало")
	assert.Equal(t, "req-1", j.recs[0].RequestID)
}

func TestForwardFallbackAndJournalFailure(t *testing.T) {
	j := &journal{err: errors.New("база лежит")}
	got, outcome := forward(t, &script{events: []chat.Event{
		ev("answer", `{"id":"a1","text":"Заглушка","fallback":true}`),
	}}, j, nil)
	assert.Equal(t, []string{"answer", "done"}, got, "сбой журнала не портит ответ, done дописывается")
	assert.Equal(t, chat.OutcomeFallback, outcome)
}

func TestForwardBrokenAndEmpty(t *testing.T) {
	got, outcome := forward(t, &script{events: []chat.Event{ev("stage", `{}`)}, err: errors.New("обрыв")}, &journal{}, nil)
	assert.Equal(t, []string{"stage", "error", "done"}, got)
	assert.Equal(t, chat.OutcomeBroken, outcome)

	got, outcome = forward(t, &script{}, &journal{}, nil)
	assert.Equal(t, []string{"error", "done"}, got)
	assert.Equal(t, chat.OutcomeEmpty, outcome)

	got, outcome = forward(t, &script{events: []chat.Event{ev("error", `{"error":"x"}`), ev("done", `{}`)}}, &journal{}, nil)
	assert.Equal(t, []string{"error", "done"}, got, "ошибка ядра не дублируется своей")
	assert.Equal(t, chat.OutcomeCoreError, outcome)
}

func TestForwardKeepsReadingAfterClientLeft(t *testing.T) {
	j := &journal{}
	got, outcome := forward(t, &script{events: []chat.Event{
		ev("stage", `{}`), ev("answer", `{"id":"a1"}`), ev("done", `{}`),
	}}, j, func(chat.Event) error { return errors.New("broken pipe") })

	assert.Equal(t, []string{"stage"}, got, "после ухода клиента не пишем")
	assert.Equal(t, chat.OutcomeAnswered, outcome)
	assert.Len(t, j.recs, 1, "ответ дочитан и лёг в журнал")
}

func TestAskDetachesCancel(t *testing.T) {
	c := &fakeCore{stream: &script{}}
	ctx, cancel := context.WithCancel(requestid.With(context.Background(), "req-1"))
	relay, err := New(c, &journal{}, time.Minute).Ask(ctx, req)
	require.NoError(t, err)
	cancel()
	assert.NoError(t, c.ctx.Err(), "ушедший клиент не отменяет запрос к ядру")
	assert.Equal(t, "req-1", requestid.From(c.ctx), "значения контекста доходят до ядра")
	relay.Forward(func(chat.Event) error { return nil })
	assert.Error(t, c.ctx.Err(), "после ответа контекст ядра освобождается")

	_, err = New(&fakeCore{err: errors.New("down")}, &journal{}, time.Minute).Ask(context.Background(), req)
	assert.Error(t, err)
}

func TestSessionTouchedAndAnswerLinked(t *testing.T) {
	st := &script{events: []chat.Event{
		ev("answer", `{"id": "a1", "text": "Ответ", "citations": [{"support": [{"id": "k1"}, {"id": "k2"}]}, {"support": [{"id": "k1"}]}]}`),
		ev("done", `{}`),
	}}
	j := &journal{}
	r := req
	r.Session = session.Ref{ID: "sess-0001", Channel: session.Embed}
	relay, err := New(&fakeCore{stream: st}, j, time.Minute).Ask(context.Background(), r)
	require.NoError(t, err)
	relay.Forward(func(chat.Event) error { return nil })

	assert.Equal(t, []string{"sess-0001|embed|Что такое АСКУЭ?"}, j.sessions, "сессия записана до ответа")
	require.Len(t, j.recs, 1)
	assert.Equal(t, "sess-0001", j.recs[0].SessionID)
	assert.Equal(t, []string{"k1", "k2"}, j.recs[0].Sources(), "разделы без повторов, по первому упоминанию")
}

func TestNoSessionNoTouch(t *testing.T) {
	st := &script{events: []chat.Event{ev("answer", `{"id": "a1", "text": "Ответ"}`), ev("done", `{}`)}}
	j := &journal{}
	_, _ = forward(t, st, j, func(chat.Event) error { return nil })
	assert.Empty(t, j.sessions)
	require.Len(t, j.recs, 1)
	assert.Empty(t, j.recs[0].SessionID)
	assert.Equal(t, []string{}, j.recs[0].Sources())
}
