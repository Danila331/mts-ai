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
	"github.com/Danila331/mts-ai/backend/internal/requestid"
)

// Journal — куда ложатся ответы.
type Journal interface {
	SaveAnswer(ctx context.Context, rec chat.Record) error
}

// journalTimeout — потолок на запись ответа в журнал.
const journalTimeout = 5 * time.Second

type Service struct {
	core    chat.Core
	journal Journal
	// timeout — потолок на весь ответ ядра.
	timeout time.Duration
}

func New(core chat.Core, journal Journal, timeout time.Duration) *Service {
	return &Service{core: core, journal: journal, timeout: timeout}
}

// Ask открывает ответ ядра.
//
// Ошибка здесь значит, что поток клиенту ещё не начат и отказ можно
// отдать обычным HTTP-ответом. Начатый поток сообщает о сбоях своим
// событием error.
//
// Контекст запроса отвязан от отмены намеренно: клиент закрыл вкладку —
// ядро всё равно досчитает ответ (модель уже работает, деньги уже
// потрачены), и ответ должен лечь в журнал, а не пропасть вместе с
// вкладкой. Потолок при этом свой — timeout. Значения контекста (логгер,
// request_id) WithoutCancel сохраняет.
func (s *Service) Ask(ctx context.Context, req chat.Request) (*Relay, error) {
	upstream, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.timeout)
	started := time.Now()
	stream, err := s.core.Chat(upstream, req)
	if err != nil {
		cancel()
		return nil, err
	}
	return &Relay{svc: s, ctx: upstream, req: req, stream: stream, cancel: cancel, started: started}, nil
}

// Relay — открытый ответ, который пересылается клиенту.
type Relay struct {
	svc     *Service
	ctx     context.Context
	req     chat.Request
	stream  chat.Stream
	cancel  context.CancelFunc
	started time.Time
}

// Forward пересылает события ядра в emit, пока поток не кончится, и
// отвечает, чем ответ кончился.
//
// emit, вернувший ошибку, означает ушедшего клиента: пересылка
// прекращается, а чтение — нет, иначе готовый ответ не попадёт в журнал.
// Поток, оборвавшийся до ответа, клиент узнаёт по событию error, а не по
// молча закрытому соединению: фронт тогда покажет причину, а не
// «соединение оборвалось».
func (r *Relay) Forward(emit func(chat.Event) error) chat.Outcome {
	defer r.cancel()
	defer func() { _ = r.stream.Close() }()
	log := zerolog.Ctx(r.ctx)

	gone := false
	send := func(ev chat.Event) {
		if gone {
			return
		}
		if err := emit(ev); err != nil {
			gone = true
			log.Info().Err(err).Msg("клиент ушёл до конца ответа — дочитываем ради журнала")
		}
	}

	var (
		outcome          chat.Outcome
		answerID         string
		answered, failed bool
		done             bool
	)
	for {
		ev, err := r.stream.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			log.Error().Err(err).Msg("поток ядра оборвался")
			if !answered && !failed {
				send(chat.ErrorEvent("Ядро оборвало ответ, попробуйте ещё раз"))
				failed, outcome = true, chat.OutcomeBroken
			}
			break
		}
		switch ev.Name {
		case chat.EventAnswer:
			answered = true
			a, ok := r.svc.record(r.ctx, r.req, ev.Data)
			answerID, outcome = a.ID, chat.OutcomeAnswered
			if ok && a.Fallback {
				outcome = chat.OutcomeFallback
			}
		case chat.EventError:
			failed, outcome = true, chat.OutcomeCoreError
		case chat.EventDone:
			done = true
		}
		send(ev)
	}

	if !answered && !failed {
		send(chat.ErrorEvent("Ядро не прислало ответ"))
		outcome = chat.OutcomeEmpty
	}
	if !done {
		send(chat.DoneEvent())
	}

	event := log.Info()
	if outcome != chat.OutcomeAnswered {
		event = log.Warn()
	}
	event.Str("outcome", string(outcome)).Str("answer_id", answerID).Str("mode", string(r.req.Mode)).
		Int("turns", len(r.req.Turns)).Bool("client_gone", gone).Dur("took", time.Since(r.started)).
		Msg("ответ ядра")
	return outcome
}

// record кладёт ответ в журнал и отдаёт разобранный ответ; ok — ответ
// разобран.
//
// Сбой журнала — не повод портить ответ клиенту: он уже получил то, за
// чем пришёл. Пропуск записи виден в журнале службы.
func (s *Service) record(ctx context.Context, req chat.Request, data json.RawMessage) (chat.Answer, bool) {
	log := zerolog.Ctx(ctx)
	var a chat.Answer
	if err := json.Unmarshal(data, &a); err != nil || a.ID == "" {
		log.Warn().Err(err).Msg("ответ ядра без id — в журнал не попал")
		return a, false
	}
	if a.Mode == "" {
		a.Mode = string(req.Mode)
	}
	rec := chat.Record{
		Answer:    a,
		Question:  dialog.LastQuestion(req.Turns),
		Turns:     len(req.Turns),
		RequestID: requestid.From(ctx),
		SessionID: req.SessionID,
	}

	// Свой потолок поверх контекста ответа: ответ, пришедший на последней
	// секунде потолка ядра, всё равно должен успеть лечь в журнал.
	jctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), journalTimeout)
	defer cancel()
	if err := s.journal.SaveAnswer(jctx, rec); err != nil {
		log.Error().Err(err).Str("answer_id", a.ID).Msg("ответ не попал в журнал")
	}
	return a, true
}
