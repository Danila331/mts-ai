package postgres

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/feedback"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/storage/postgres/db"
)

// SaveAnswer кладёт ответ в журнал.
func (s *Store) SaveAnswer(ctx context.Context, rec chat.Record) error {
	return s.Queries.SaveAnswer(ctx, db.SaveAnswerParams{
		ID:        rec.ID,
		Mode:      rec.Mode,
		Question:  rec.Question,
		Answer:    rec.Text,
		Fallback:  rec.Fallback,
		Error:     rec.Error,
		Model:     rec.Model,
		Turns:     int32(rec.Turns),
		Timings:   object(rec.Timings),
		Guard:     object(rec.Guard),
		RequestID: rec.RequestID,
	})
}

// CreateLead сохраняет заявку. Занятый номер отдаётся как
// lead.ErrCodeTaken — сервис попробует другой.
func (s *Store) CreateLead(ctx context.Context, l *lead.Lead) error {
	messages, err := json.Marshal(l.Messages)
	if err != nil {
		return err
	}
	if l.Messages == nil {
		messages = []byte("[]")
	}
	row, err := s.Queries.CreateLead(ctx, db.CreateLeadParams{
		Code:          l.Code,
		Name:          l.Name,
		Phone:         l.Phone,
		Company:       l.Company,
		Comment:       l.Comment,
		Summary:       l.Summary,
		SummarySource: summarySource(l.SummarySource),
		Messages:      messages,
		RequestID:     l.RequestID,
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == pgerrcode.UniqueViolation && pgErr.ConstraintName == "leads_code_uq" {
		return lead.ErrCodeTaken
	}
	if err != nil {
		return err
	}
	l.ID, l.CreatedAt = row.ID, row.CreatedAt
	return nil
}

// errLeadNotFound — обновлять нечего: заявки с таким id нет.
var errLeadNotFound = errors.New("заявка не найдена")

// UpdateLeadSummary заменяет резюме сохранённой заявки.
func (s *Store) UpdateLeadSummary(ctx context.Context, l *lead.Lead) error {
	n, err := s.Queries.UpdateLeadSummary(ctx, db.UpdateLeadSummaryParams{
		ID:            l.ID,
		Summary:       l.Summary,
		SummarySource: summarySource(l.SummarySource),
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return errLeadNotFound
	}
	return nil
}

// summarySource — пустой источник — это список вопросов: так заявка
// записывается до резюме моделью.
func summarySource(s lead.SummarySource) string {
	if s == "" {
		return string(lead.SummaryDigest)
	}
	return string(s)
}

// CreateFeedback сохраняет оценку.
func (s *Store) CreateFeedback(ctx context.Context, f feedback.Feedback) error {
	return s.Queries.CreateFeedback(ctx, db.CreateFeedbackParams{
		SessionID: f.SessionID,
		MessageID: f.MessageID,
		Rating:    int16(f.Rating),
		Comment:   f.Comment,
		Question:  f.Question,
		Answer:    f.Answer,
	})
}

// object — JSON-объект для колонки jsonb NOT NULL. Ядро может прислать
// null или ничего — это пустой объект, а не нарушение NOT NULL.
func object(raw json.RawMessage) []byte {
	var probe map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &probe) != nil || probe == nil {
		return []byte("{}")
	}
	return raw
}
