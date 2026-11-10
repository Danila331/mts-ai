// Package usecase ведёт один ответ: от вопроса клиента до записи в
// журнал.
package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/rs/zerolog"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
)

// Stream — поток событий ответа. Next отдаёт io.EOF, когда поток
// закончился.
type Stream interface {
	Next() (chat.Event, error)
	Close() error
}

// Core — то, что строит ответ.
type Core interface {
	Chat(ctx context.Context, req chat.Request) (Stream, error)
}

// Journal — куда ложатся ответы.
type Journal interface {
	SaveAnswer(ctx context.Context, rec chat.Record) error
}

type Service struct {
	core    Core
	journal Journal
	log     zerolog.Logger
	// timeout — потолок на весь ответ ядра.
	timeout time.Duration
}

func New(core Core, journal Journal, log zerolog.Logger, timeout time.Duration) *Service {
	return &Service{core: core, journal: journal, log: log, timeout: timeout}
}

// Ask открывает ответ ядра.
//
// Ошибка здесь значит, что поток клиенту ещё не начат и отказ можно
// отдать обычным HTTP-ответом. Начатый поток сообщает о сбоях своим
// событием error.
//
// Контекст запроса отвязан намеренно: клиент закрыл вкладку — ядро всё
// равно досчитает ответ (модель уже работает, деньги уже потрачены), и
// ответ должен лечь в журнал, а не пропасть вместе с вкладкой. Потолок
// при этом свой — timeout.
func (s *Service) Ask(ctx context.Context, req chat.Request) (*Relay, error) {
	upstream, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.timeout)
	stream, err := s.core.Chat(upstream, req)
	if err != nil {
		cancel()
		return nil, err
	}
	return &Relay{svc: s, req: req, stream: stream, cancel: cancel}, nil
}

// Relay — открытый ответ, который пересылается клиенту.
type Relay struct {
	svc    *Service
	req    chat.Request
	stream Stream
	cancel context.CancelFunc
}

// Forward пересылает события ядра в emit, пока поток не кончится.
//
// emit, вернувший ошибку, означает ушедшего клиента: пересылка
// прекращается, а чтение — нет, иначе готовый ответ не попадёт в журнал.
// Поток, оборвавшийся до ответа, клиент узнаёт по событию error, а не по
// молча закрытому соединению: фронт тогда покажет причину, а не
// «соединение оборвалось».
func (r *Relay) Forward(emit func(chat.Event) error) {
	defer r.cancel()
	defer func() { _ = r.stream.Close() }()

	gone := false
	send := func(ev chat.Event) {
		if gone {
			return
		}
		if err := emit(ev); err != nil {
			gone = true
		}
	}

	answered, failed, done := false, false, false
	for {
		ev, err := r.stream.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			r.svc.log.Error().Err(err).Msg("поток ядра оборвался")
			if !answered && !failed {
				send(chat.ErrorEvent("Ядро оборвало ответ, попробуйте ещё раз"))
				failed = true
			}
			break
		}
		switch ev.Name {
		case chat.EventAnswer:
			answered = true
			r.svc.record(r.req, ev.Data)
		case chat.EventError:
			failed = true
		case chat.EventDone:
			done = true
		}
		send(ev)
	}

	if !answered && !failed {
		send(chat.ErrorEvent("Ядро не прислало ответ"))
	}
	if !done {
		send(chat.DoneEvent())
	}
}

// record кладёт ответ в журнал.
//
// Сбой журнала — не повод портить ответ клиенту: он уже получил то, за
// чем пришёл. Пропуск записи виден в логе службы.
func (s *Service) record(req chat.Request, data json.RawMessage) {
	var a chat.Answer
	if err := json.Unmarshal(data, &a); err != nil || a.ID == "" {
		s.log.Warn().Err(err).Msg("ответ ядра без id — в журнал не попал")
		return
	}
	if a.Mode == "" {
		a.Mode = string(req.Mode)
	}
	rec := chat.Record{Answer: a, Question: dialog.LastQuestion(req.Turns), Turns: len(req.Turns)}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.journal.SaveAnswer(ctx, rec); err != nil {
		s.log.Error().Err(err).Str("answer", a.ID).Msg("ответ не попал в журнал")
	}
}
