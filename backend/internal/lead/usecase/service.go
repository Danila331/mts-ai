// Package usecase принимает заявку: от формы до строки в базе.
package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/rs/zerolog"

	"github.com/Danila331/mts-ai/backend/internal/ai/llm"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/lead"
)

// ErrCodeTaken — номер заявки уже занят. Хранилище отдаёт его, чтобы
// сервис попробовал другой, а не отказал клиенту.
var ErrCodeTaken = errors.New("lead: номер заявки занят")

// Repository — куда ложатся заявки.
type Repository interface {
	// CreateLead сохраняет заявку и заполняет ID и CreatedAt.
	CreateLead(ctx context.Context, l *lead.Lead) error
}

// Summarizer — модель, которая пишет резюме.
type Summarizer interface {
	Configured() bool
	Chat(ctx context.Context, messages []llm.Message, maxTokens int) (string, error)
}

type Service struct {
	repo  Repository
	model Summarizer
	log   zerolog.Logger
}

func New(repo Repository, model Summarizer, log zerolog.Logger) *Service {
	return &Service{repo: repo, model: model, log: log}
}

// Create принимает заявку. Диалог необязателен: клиент может оставить
// контакты, ничего не спросив.
func (s *Service) Create(ctx context.Context, c lead.Contacts, messages json.RawMessage) (lead.Lead, error) {
	turns, err := dialog.Clean(messages, false)
	if err != nil {
		return lead.Lead{}, err
	}

	// Клиент, закрывший вкладку после «Отправить», заявку уже отправил:
	// отмена запроса не должна её терять. Потолок свой — минута на
	// резюме и запись.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Minute)
	defer cancel()

	l := lead.Lead{
		Contacts: c.Normalize(),
		Summary:  s.summary(ctx, turns),
		Messages: turns,
	}

	// Три попытки на номер: совпадение десяти случайных знаков —
	// событие редкое, а не невозможное, и отказ клиенту из-за него был
	// бы нелепым.
	for attempt := 0; attempt < 3; attempt++ {
		l.Code = lead.NewCode()
		err = s.repo.CreateLead(ctx, &l)
		if !errors.Is(err, ErrCodeTaken) {
			break
		}
	}
	if err != nil {
		return lead.Lead{}, fmt.Errorf("сохранить заявку: %w", err)
	}
	return l, nil
}

// summary — резюме моделью, а без неё — список вопросов клиента.
//
// Заявка важнее резюме: модель недоступна, ключа нет, ответ пустой —
// заявка всё равно ложится в базу.
func (s *Service) summary(ctx context.Context, turns []dialog.Turn) string {
	transcript := dialog.Transcript(turns)
	if s.model == nil || !s.model.Configured() || transcript == "" {
		return dialog.Digest(turns)
	}
	// Резюме ждём не дольше 40 секунд: дальше клиент смотрит на крутилку,
	// а заявка без резюме лучше, чем заявка, которую не дождались.
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	text, err := s.model.Chat(ctx, []llm.Message{
		{Role: "system", Content: lead.SummarySystem},
		{Role: "user", Content: "ДИАЛОГ\n" + transcript},
	}, lead.SummaryMaxTokens)
	if err != nil {
		s.log.Warn().Err(err).Msg("резюме заявки без модели")
		return dialog.Digest(turns)
	}
	if text == "" {
		return dialog.Digest(turns)
	}
	return text
}
