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
	"github.com/Danila331/mts-ai/backend/internal/passport"
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
	req    chat.Request
}

func (c *fakeCore) Chat(ctx context.Context, r chat.Request) (chat.Stream, error) {
	c.ctx, c.req = ctx, r
	if c.err != nil {
		return nil, c.err
	}
	return c.stream, nil
}

type journal struct {
	mu       sync.Mutex
	recs     []chat.Record
	sessions []string
	roles    []session.RoleHint
	levels   []session.LevelChoice
	err      error
}

func (j *journal) TouchSession(_ context.Context, ref session.Ref, _, title string, role session.RoleHint,
	level session.LevelChoice) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.sessions = append(j.sessions, ref.ID+"|"+string(ref.Channel)+"|"+title)
	j.roles = append(j.roles, role)
	j.levels = append(j.levels, level)
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

func TestForwardPassesDeltasAsIs(t *testing.T) {
	j := &journal{}
	deltas := []string{`{"text":"Платформа "}`, `{"text":"учёта \u003c 5 кВт"}`, `{"text":"…"}`}
	var data []string
	got, outcome := forward(t, &script{events: []chat.Event{
		ev("stage", `{"name":"generation"}`),
		ev(chat.EventDelta, deltas[0]), ev(chat.EventDelta, deltas[1]), ev(chat.EventDelta, deltas[2]),
		ev("answer", `{"id":"a1","text":"Итоговый текст после проверки","streamed":true,"revised":true}`),
		ev("done", `{}`),
	}}, j, func(e chat.Event) error {
		if e.Name == chat.EventDelta {
			data = append(data, string(e.Data))
		}
		return nil
	})

	assert.Equal(t, []string{"stage", "delta", "delta", "delta", "answer", "done"}, got, "порядок как у ядра")
	assert.Equal(t, deltas, data, "данные дельт — байт в байт")
	assert.Equal(t, chat.OutcomeAnswered, outcome)
	require.Len(t, j.recs, 1, "в журнал — только ответ, дельты не пишутся")
	assert.Equal(t, "Итоговый текст после проверки", j.recs[0].Text, "в журнале финальный текст, а не напечатанный")
}

func TestForwardDeltasWithoutAnswerAreBroken(t *testing.T) {
	got, outcome := forward(t, &script{events: []chat.Event{
		ev("delta", `{"text":"Начало"}`),
	}, err: errors.New("обрыв")}, &journal{}, nil)
	assert.Equal(t, []string{"delta", "error", "done"}, got, "напечатанное без answer — обрыв, клиент узнаёт об этом")
	assert.Equal(t, chat.OutcomeBroken, outcome)
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

// passportStore — паспорт сессии в памяти: только для роли по типу
// организации.
type passportStore struct{ p map[string]passport.Passport }

func (s passportStore) LoadPassport(_ context.Context, id string) (passport.Passport, error) {
	p, ok := s.p[id]
	if !ok {
		return passport.Passport{}, session.ErrNotFound
	}
	return p, nil
}

func (s passportStore) SavePassport(context.Context, string, passport.Passport) error { return nil }

func TestRoleResolvedAndStored(t *testing.T) {
	ask := func(t *testing.T, svc *Service, r chat.Request) (session.RoleHint, session.RoleHint) {
		t.Helper()
		core := &fakeCore{stream: &script{events: []chat.Event{ev("answer", `{"id": "a1", "text": "Ответ"}`), ev("done", `{}`)}}}
		svc.core = core
		j := svc.journal.(*journal)
		before := len(j.roles)
		relay, err := svc.Ask(context.Background(), r)
		require.NoError(t, err)
		relay.Forward(func(chat.Event) error { return nil })
		var stored session.RoleHint
		if len(j.roles) > before {
			stored = j.roles[len(j.roles)-1]
		}
		return core.req.Role, stored
	}
	grid := []dialog.Turn{{Role: dialog.RoleUser, Content: "Мы электросетевая компания, хотим находить потери"}}
	plain := []dialog.Turn{{Role: dialog.RoleUser, Content: "Что нужно для подключения платформы учёта?"}}
	ref := session.Ref{ID: "sess-role-1", Channel: session.Embed}
	store := passportStore{p: map[string]passport.Passport{
		"sess-role-1": {Values: map[string]passport.Value{"org_type": {Value: "управляющая компания"}}},
	}}

	t.Run("по репликам клиента без клика", func(t *testing.T) {
		svc := New(nil, &journal{}, time.Minute)
		sent, stored := ask(t, svc, chat.Request{Turns: grid, Mode: dialog.ModeChat, Session: ref})
		want := session.RoleHint{Role: session.RoleGrid, Source: session.RoleAuto}
		assert.Equal(t, want, sent, "ядро получило роль")
		assert.Equal(t, want, stored, "роль записана в сессию")
	})
	t.Run("выбор клиента главнее реплик", func(t *testing.T) {
		svc := New(nil, &journal{}, time.Minute)
		pick := session.RoleHint{Role: session.RoleMTSManager, Source: session.RoleByClient}
		sent, stored := ask(t, svc, chat.Request{Turns: grid, Mode: dialog.ModeChat, Session: ref, Role: pick})
		assert.Equal(t, pick, sent)
		assert.Equal(t, pick, stored)
		// «Не указывать» — тоже выбор: автоопределение роль не возвращает.
		off := session.RoleHint{Source: session.RoleByClient}
		sent, stored = ask(t, svc, chat.Request{Turns: grid, Mode: dialog.ModeChat, Session: ref, Role: off})
		assert.False(t, sent.Known())
		assert.Equal(t, off, stored, "снятая роль стирает прежнюю в сессии")
	})
	t.Run("по типу организации из паспорта", func(t *testing.T) {
		svc := New(nil, &journal{}, time.Minute).WithPassport(store, nil)
		sent, stored := ask(t, svc, chat.Request{Turns: plain, Mode: dialog.ModeChat, Session: ref})
		want := session.RoleHint{Role: session.RoleHousing, Source: session.RoleAuto}
		assert.Equal(t, want, sent)
		assert.Equal(t, want, stored)
	})
	t.Run("роли нет — сессия её не теряет", func(t *testing.T) {
		svc := New(nil, &journal{}, time.Minute).WithPassport(passportStore{}, nil)
		sent, stored := ask(t, svc, chat.Request{Turns: plain, Mode: dialog.ModeChat, Session: ref})
		assert.False(t, sent.Known())
		assert.Equal(t, session.RoleHint{}, stored, "пустой источник — UpsertSession оставит прежнюю роль")
	})
	t.Run("автопроверка и копилот — без роли", func(t *testing.T) {
		for _, mode := range []dialog.Mode{dialog.ModeEval, dialog.ModeCopilot} {
			svc := New(nil, &journal{}, time.Minute)
			pick := session.RoleHint{Role: session.RoleGrid, Source: session.RoleByClient}
			sent, _ := ask(t, svc, chat.Request{Turns: grid, Mode: mode, Session: ref, Role: pick})
			assert.False(t, sent.Known(), mode)
		}
	})
}

func TestLevelPassedAndStored(t *testing.T) {
	ask := func(t *testing.T, r chat.Request) (session.LevelChoice, session.LevelChoice) {
		t.Helper()
		j := &journal{}
		svc := New(nil, j, time.Minute)
		core := &fakeCore{stream: &script{events: []chat.Event{ev("answer", `{"id": "a1", "text": "Ответ"}`), ev("done", `{}`)}}}
		svc.core = core
		relay, err := svc.Ask(context.Background(), r)
		require.NoError(t, err)
		relay.Forward(func(chat.Event) error { return nil })
		var stored session.LevelChoice
		if len(j.levels) > 0 {
			stored = j.levels[len(j.levels)-1]
		}
		return core.req.Level, stored
	}
	ref := session.Ref{ID: "sess-level-1", Channel: session.Embed}
	pick := session.LevelChoice{Level: session.LevelSimple, Chosen: true}

	sent, stored := ask(t, chat.Request{Turns: req.Turns, Mode: dialog.ModeChat, Session: ref, Level: pick})
	assert.Equal(t, pick, sent, "ядро получило уровень")
	assert.Equal(t, pick, stored, "уровень записан в сессию")

	for _, mode := range []dialog.Mode{dialog.ModeEval, dialog.ModeCopilot} {
		sent, stored = ask(t, chat.Request{Turns: req.Turns, Mode: mode, Session: ref, Level: pick})
		assert.Equal(t, session.LevelChoice{}, sent, mode)
		assert.Equal(t, session.LevelChoice{}, stored, "в автопроверке и копилоте сессия уровень не получает")
	}
}
