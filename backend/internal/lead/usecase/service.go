// Package usecase принимает заявку: от формы до строки в базе.
package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/rs/zerolog"

	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/lead"
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
	repo  Repository
	model Summarizer
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
func (s *Service) Create(ctx context.Context, c lead.Contacts, messages json.RawMessage, sessionID string) (lead.Lead, error) {
	turns, err := dialog.Clean(messages, false)
	if err != nil {
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

	s.summarize(ctx, &l, turns)

	// Контакты в журнал не пишутся: там телефоны.
	log.Info().Str("lead_code", l.Code).Str("summary_source", string(l.SummarySource)).
		Int("turns", len(turns)).Dur("took", time.Since(started)).Msg("заявка принята")
	return l, nil
}

// summarize заменяет резюме-список резюме моделью, если модель есть и
// ответила. Любой сбой оставляет заявку с тем, что уже записано.
func (s *Service) summarize(ctx context.Context, l *lead.Lead, turns []dialog.Turn) {
	transcript := dialog.Transcript(turns)
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
	updated.Summary, updated.SummarySource = text, lead.SummaryLLM
	if err := s.repo.UpdateLeadSummary(ctx, &updated); err != nil {
		// Клиенту показываем то же, что увидит менеджер, — то, что в базе.
		log.Error().Err(err).Str("lead_code", l.Code).Msg("резюме моделью не записано — в заявке список вопросов")
		return
	}
	*l = updated
}
