// Package usecase принимает заявку: от формы до строки в базе.
package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/rs/zerolog"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/lead/score"
	"github.com/Danila331/mts-ai/backend/internal/passport"
	"github.com/Danila331/mts-ai/backend/internal/requestid"
)

// Repository — куда ложатся заявки.
type Repository interface {
	// CreateLead сохраняет заявку и заполняет ID и CreatedAt. Занятый
	// номер — lead.ErrCodeTaken.
	CreateLead(ctx context.Context, l *lead.Lead) error
	// UpdateLeadSummary заменяет резюме сохранённой заявки.
	UpdateLeadSummary(ctx context.Context, l *lead.Lead) error
}

// Summarizer — модель, которая пишет резюме.
//
// Порт в словах сценария: «указание и текст → ответ». Форма сообщений
// конкретного API — забота адаптера, и сценарий от неё не зависит.
type Summarizer interface {
	Configured() bool
	Complete(ctx context.Context, system, user string, maxTokens int) (string, error)
}

const (
	// budget — потолок на всю заявку: запись, резюме, обновление.
	budget = time.Minute
	// summaryTimeout — сколько ждать резюме. Дальше клиент смотрит на
	// крутилку, а заявка уже сохранена и без него.
	summaryTimeout = 40 * time.Second
	// codeAttempts — попыток на номер: совпадение десяти случайных
	// знаков — событие редкое, а не невозможное.
	codeAttempts = 3
)

type Service struct {
	repo      Repository
	model     Summarizer
	passports Passports
}

// Passports — паспорт задачи сессии (internal/passport).
type Passports interface {
	LoadPassport(ctx context.Context, id string) (passport.Passport, error)
	SavePassport(ctx context.Context, id string, p passport.Passport) error
}

// WithPassports — заявка из разговора берёт паспорт с сервера.
func (s *Service) WithPassports(p Passports) *Service {
	s.passports = p
	return s
}

// attachPassport копирует паспорт сессии в заявку и записывает в паспорт
// контакты, которые клиент подтвердил в карточке. Сессии нет или база не
// ответила — заявка уходит без паспорта (view == nil): она важнее.
// Паспорт возвращается и в этом случае — пустой, для скоринга.
//
// Тип заявки проверяется здесь же, до записи в паспорт: демо-кабинет и
// пилот годятся, только если в разговоре обсуждали платформу учёта.
func (s *Service) attachPassport(ctx context.Context, l *lead.Lead) (passport.Passport, *passport.View, error) {
	empty := passport.Parse(nil)
	if s.passports == nil || l.SessionID == "" {
		return empty, nil, checkKind(l.Kind, nil)
	}
	log := zerolog.Ctx(ctx)
	p, err := s.passports.LoadPassport(ctx, l.SessionID)
	if err != nil {
		log.Warn().Err(err).Str("session_id", l.SessionID).Msg("заявка без паспорта")
		return empty, nil, checkKind(l.Kind, nil)
	}
	if err := checkKind(l.Kind, p.Candidates); err != nil {
		return empty, nil, err
	}
	now := time.Now()
	for key, v := range map[string]string{"name": l.Name, "phone": l.Phone, "company": l.Company,
		"callback_preference": l.Callback.Label()} {
		if clean, err := passport.Clean(key, v); err == nil && clean != "" {
			p.Set(key, clean, passport.FromClient, now)
		}
	}
	if err := s.passports.SavePassport(ctx, l.SessionID, p); err != nil {
		log.Warn().Err(err).Str("session_id", l.SessionID).Msg("контакты заявки не записаны в паспорт")
	}
	view := p.Render()
	if raw, err := json.Marshal(view); err == nil {
		l.Passport = raw
	}
	return p, &view, nil
}

// checkKind — тип заявки годится для продуктов из паспорта (lead.KindsFor).
func checkKind(k lead.Kind, candidates []passport.Candidate) error {
	if k.Allowed(candidates) {
		return nil
	}
	return apperr.Invalidf("«" + k.Label() + "» — только для платформы учёта, а в разговоре её не обсуждали. " +
		"Выберите обратный звонок или предварительную оценку")
}

// kindLine — тип заявки первой строкой резюме: менеджер видит его сразу.
func kindLine(k lead.Kind) string {
	return "Тип заявки: " + k.Label() + "\n"
}

// callbackLine — удобное время отдельной строкой в конце резюме: его
// выбрал клиент кнопкой, пересказывать его модели незачем. Пусто — не
// выбрано.
func callbackLine(c lead.Callback) string {
	if c.Empty() {
		return ""
	}
	return "\nУдобное время для звонка: " + c.Label()
}

// missingLine — строка резюме «что уточнить» из скоринга; пусто — нечего.
func missingLine(sc score.Score) string {
	if len(sc.Missing) == 0 {
		return ""
	}
	return "Что уточнить менеджеру: " + strings.Join(sc.Missing, ", ")
}

// passportText — заполненные поля паспорта строками «Поле: значение».
func passportText(v passport.View) string {
	var b strings.Builder
	b.WriteString("ПАСПОРТ ЗАДАЧИ (клиент видел и подтвердил)")
	for _, f := range v.Fields {
		if f.Value != "" && f.Group != passport.Contacts {
			fmt.Fprintf(&b, "\n%s: %s", f.Label, f.Value)
		}
	}
	return b.String()
}

func New(repo Repository, model Summarizer) *Service {
	return &Service{repo: repo, model: model}
}

// Create принимает заявку. Диалог необязателен: клиент может оставить
// контакты, ничего не спросив.
//
// Порядок — сначала запись, потом модель. Заявка — это звонок менеджера,
// резюме — удобство к нему: если база недоступна, тратить на модель
// время клиента и деньги незачем, а если недоступна модель, заявка уже
// лежит в базе со списком вопросов.
// Create — заявка из формы без сессии (старый путь и внешние вызовы).
func (s *Service) Create(ctx context.Context, c lead.Contacts, messages json.RawMessage) (lead.Lead, error) {
	return s.CreateForSession(ctx, c, messages, "")
}

// CreateForSession — заявка из разговора: паспорт задачи берётся с сервера
// и копируется в заявку, контакты из карточки, которую клиент проверил,
// записываются в паспорт как его собственные.
func (s *Service) CreateForSession(ctx context.Context, c lead.Contacts, messages json.RawMessage, sessionID string) (lead.Lead, error) {
	turns, err := dialog.Clean(messages, false)
	if err != nil {
		return lead.Lead{}, err
	}
	if c.Callback, err = c.Callback.Normalize(); err != nil {
		return lead.Lead{}, err
	}
	if c.Kind, err = lead.ParseKind(string(c.Kind)); err != nil {
		return lead.Lead{}, err
	}

	// Клиент, закрывший вкладку после «Отправить», заявку уже отправил:
	// отмена запроса не должна её терять. Потолок свой.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), budget)
	defer cancel()
	log := zerolog.Ctx(ctx)
	started := time.Now()

	l := lead.Lead{
		Contacts:      c.Normalize(),
		Summary:       dialog.Digest(turns),
		SummarySource: lead.SummaryDigest,
		Messages:      turns,
		RequestID:     requestid.From(ctx),
		SessionID:     sessionID,
	}
	p, view, err := s.attachPassport(ctx, &l)
	if err != nil {
		return lead.Lead{}, err
	}
	// Скоринг — правилами, до записи: заявка сохраняется сразу с оценкой.
	// Клиент нажал «Отправить» с согласием — значит, сам просит связаться.
	l.Score = score.Of(score.Input{Passport: p, Turns: turns, Agreed: true})
	if line := missingLine(l.Score); line != "" {
		l.Summary += "\n" + line
	}
	l.Summary = kindLine(l.Kind) + l.Summary + callbackLine(l.Callback)
	for attempt := 0; attempt < codeAttempts; attempt++ {
		l.Code = lead.NewCode()
		err = s.repo.CreateLead(ctx, &l)
		if !errors.Is(err, lead.ErrCodeTaken) {
			break
		}
		log.Warn().Int("attempt", attempt+1).Msg("номер заявки занят — пробуем другой")
	}
	if err != nil {
		return lead.Lead{}, fmt.Errorf("сохранить заявку: %w", err)
	}

	s.summarize(ctx, &l, turns, view)

	// Контакты в журнал не пишутся: там телефоны.
	log.Info().Str("lead_code", l.Code).Str("summary_source", string(l.SummarySource)).
		Str("kind", string(l.Kind)).Str("grade", string(l.Score.Grade)).Int("points", l.Score.Points).
		Int("turns", len(turns)).Dur("took", time.Since(started)).Msg("заявка принята")
	return l, nil
}

// summarize заменяет резюме-список резюме моделью, если модель есть и
// ответила. Любой сбой оставляет заявку с тем, что уже записано.
func (s *Service) summarize(ctx context.Context, l *lead.Lead, turns []dialog.Turn, view *passport.View) {
	transcript := dialog.Transcript(turns)
	if len(l.Score.Missing) > 0 && transcript != "" {
		// Что спросить на звонке посчитал скоринг — модель только формулирует.
		transcript = "НЕ ЗАПОЛНЕНО (спросить на звонке): " + strings.Join(l.Score.Missing, ", ") + "\n\n" + transcript
	}
	if view != nil {
		// Паспорт клиент видел и мог поправить: для резюме он надёжнее пересказа.
		transcript = passportText(*view) + "\n\n" + transcript
	}
	if s.model == nil || !s.model.Configured() || transcript == "" {
		return
	}
	log := zerolog.Ctx(ctx)

	sctx, cancel := context.WithTimeout(ctx, summaryTimeout)
	defer cancel()
	started := time.Now()
	text, err := s.model.Complete(sctx, lead.SummarySystem, "ДИАЛОГ\n"+transcript, lead.SummaryMaxTokens)
	if err != nil || text == "" {
		log.Warn().Err(err).Str("lead_code", l.Code).Dur("took", time.Since(started)).
			Msg("резюме заявки без модели")
		return
	}

	updated := *l
	updated.Summary, updated.SummarySource = kindLine(l.Kind)+text+callbackLine(l.Callback), lead.SummaryLLM
	if err := s.repo.UpdateLeadSummary(ctx, &updated); err != nil {
		// Клиенту показываем то же, что увидит менеджер, — то, что в базе.
		log.Error().Err(err).Str("lead_code", l.Code).Msg("резюме моделью не записано — в заявке список вопросов")
		return
	}
	*l = updated
}
