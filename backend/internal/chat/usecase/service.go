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
	"github.com/Danila331/mts-ai/backend/internal/passport"
	"github.com/Danila331/mts-ai/backend/internal/requestid"
	"github.com/Danila331/mts-ai/backend/internal/session"
)

// Journal — куда ложатся ответы и сессии.
type Journal interface {
	SaveAnswer(ctx context.Context, rec chat.Record) error
	// TouchSession создаёт сессию на первом вопросе и отмечает каждый
	// следующий; роль вопроса (T15) пишется в сессию, неизвестная прежнюю
	// не стирает; уровень объяснения (T16) пишется, только если клиент его
	// прислал.
	TouchSession(ctx context.Context, ref session.Ref, mode, title string, role session.RoleHint, level session.LevelChoice) error
}

// journalTimeout — потолок на запись ответа в журнал.
const journalTimeout = 5 * time.Second

type Service struct {
	core    chat.Core
	journal Journal
	// timeout — потолок на весь ответ ядра.
	timeout time.Duration
	// Паспорт задачи (T2): без хранилища паспорт не ведётся, без модели —
	// только телефон, найденный кодом.
	passports Passports
	model     passport.Model
}

// Passports — где живёт паспорт сессии.
type Passports interface {
	LoadPassport(ctx context.Context, id string) (passport.Passport, error)
	SavePassport(ctx context.Context, id string, p passport.Passport) error
}

// passportTimeout — потолок на разбор диалога моделью. Клиент уже видит
// ответ: дольше ждать паспорт незачем, он догонит на следующем вопросе.
const passportTimeout = 20 * time.Second

func New(core chat.Core, journal Journal, timeout time.Duration) *Service {
	return &Service{core: core, journal: journal, timeout: timeout}
}

// WithPassport включает паспорт задачи.
func (s *Service) WithPassport(store Passports, model passport.Model) *Service {
	s.passports, s.model = store, model
	return s
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
	req.Role = s.role(ctx, req)
	req.Level = s.levelFor(req)
	s.touch(ctx, req)
	req.Passport = s.passportFor(ctx, req)
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
		lastAnswer       chat.Answer
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
			lastAnswer = a
			answerID, outcome = a.ID, chat.OutcomeAnswered
			if ok && a.Fallback {
				outcome = chat.OutcomeFallback
			}
		case chat.EventError:
			failed, outcome = true, chat.OutcomeCoreError
		case chat.EventDone:
			done = true
			// Паспорт — после ответа и до done: клиент уже читает ответ, а
			// поток ещё открыт.
			if answered && !failed {
				if ev, ok := r.svc.passport(r.ctx, r.req, lastAnswer); ok {
					send(ev)
				}
			}
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

// passport обновляет паспорт сессии по диалогу и отдаёт событие для
// клиента. Только режим chat и только с сессией. Любой сбой — паспорт как
// был, ответ клиента не страдает.
func (s *Service) passport(ctx context.Context, req chat.Request, a chat.Answer) (chat.Event, bool) {
	if s.passports == nil || req.Session.ID == "" || req.Mode != dialog.ModeChat {
		return chat.Event{}, false
	}
	log := zerolog.Ctx(ctx)
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), passportTimeout)
	defer cancel()

	p, err := s.passports.LoadPassport(pctx, req.Session.ID)
	if err != nil {
		log.Warn().Err(err).Str("session_id", req.Session.ID).Msg("паспорт не прочитан")
		return chat.Event{}, false
	}
	started := time.Now()
	u, err := passport.Extract(pctx, s.model, req.Turns)
	if err != nil {
		// Найденное кодом (телефон) всё равно идёт в паспорт.
		log.Warn().Err(err).Dur("took", time.Since(started)).Msg("паспорт без модели")
	}
	if len(u.Dropped) > 0 {
		log.Info().Strs("fields", u.Dropped).Msg("паспорт: значения не из реплик клиента отброшены")
	}
	now := time.Now()
	for k, v := range u.Values {
		p.Set(k, v, passport.FromBot, now)
	}
	if u.HandoffAgreed {
		p.HandoffAgreed = true
	}
	p.AddSections(a.SectionRefs())
	if err := s.passports.SavePassport(pctx, req.Session.ID, p); err != nil {
		log.Error().Err(err).Str("session_id", req.Session.ID).Msg("паспорт не записан")
		return chat.Event{}, false
	}
	data, err := json.Marshal(p.Render())
	if err != nil {
		return chat.Event{}, false
	}
	return chat.Event{Name: chat.EventPassport, Data: data}, true
}

// role — роль-подсказка вопроса (T15). Только режим chat: в автопроверке
// и копилоте роли нет. Выбор клиента главнее всего, в том числе «не
// указывать»; роль, которую прислал фронт, — как есть. Иначе служба
// определяет её сама: по репликам клиента, затем по типу организации из
// паспорта сессии (T2). Так роль есть и у клиента, который её не прислал
// (старый фронт, Telegram), и одна и та же реплика даёт одну и ту же роль.
func (s *Service) role(ctx context.Context, req chat.Request) session.RoleHint {
	if req.Mode != dialog.ModeChat {
		return session.RoleHint{}
	}
	if req.Role.Source == session.RoleByClient || req.Role.Known() {
		return req.Role
	}
	var client []string
	for _, t := range req.Turns {
		if t.Role == dialog.RoleUser {
			client = append(client, t.Content)
		}
	}
	if r := session.DetectRole(client); r != "" {
		return session.RoleHint{Role: r, Source: session.RoleAuto}
	}
	if s.passports == nil || req.Session.ID == "" {
		return session.RoleHint{}
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), journalTimeout)
	defer cancel()
	p, err := s.passports.LoadPassport(pctx, req.Session.ID)
	if err != nil {
		// Сессии ещё нет (первый вопрос) или база не ответила: без роли.
		if !errors.Is(err, session.ErrNotFound) {
			zerolog.Ctx(ctx).Warn().Err(err).Str("session_id", req.Session.ID).Msg("роль: паспорт не прочитан")
		}
		return session.RoleHint{}
	}
	if r := session.RoleFromOrgType(p.Values["org_type"].Value); r != "" {
		return session.RoleHint{Role: r, Source: session.RoleAuto}
	}
	return session.RoleHint{}
}

// passportFor — паспорт сессии для ядра (T26). Нет сессии, не чат или
// база не ответила — без паспорта: правила смотрят тогда только реплики.
func (s *Service) passportFor(ctx context.Context, req chat.Request) json.RawMessage {
	if s.passports == nil || req.Session.ID == "" || req.Mode != dialog.ModeChat {
		return nil
	}
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), journalTimeout)
	defer cancel()
	p, err := s.passports.LoadPassport(pctx, req.Session.ID)
	if err != nil || len(p.Values) == 0 {
		return nil
	}
	raw, err := json.Marshal(p.Render())
	if err != nil {
		return nil
	}
	return raw
}

// levelFor — уровень объяснения вопроса (T16). Только режим chat: в
// автопроверке и копилоте уровня нет, и в сессию он тоже не пишется.
func (s *Service) levelFor(req chat.Request) session.LevelChoice {
	if req.Mode != dialog.ModeChat {
		return session.LevelChoice{}
	}
	return req.Level
}

// touch записывает сессию до ответа: разговор виден на сервере, даже если
// ядро так и не ответит. Сбой базы ответ не останавливает — он в журнале
// службы.
func (s *Service) touch(ctx context.Context, req chat.Request) {
	if req.Session.ID == "" {
		return
	}
	jctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), journalTimeout)
	defer cancel()
	title := session.Title(dialog.LastQuestion(req.Turns))
	if err := s.journal.TouchSession(jctx, req.Session, string(req.Mode), title, req.Role, s.levelFor(req)); err != nil {
		zerolog.Ctx(ctx).Error().Err(err).Str("session_id", req.Session.ID).Msg("сессия не записана")
	}
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
		SessionID: req.Session.ID,
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
