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
	leaduc "github.com/Danila331/mts-ai/backend/internal/lead/usecase"
	"github.com/Danila331/mts-ai/backend/internal/storage/postgres/db"
)

// SaveAnswer кладёт ответ в журнал.
func (s *Store) SaveAnswer(ctx context.Context, rec chat.Record) error {
	return s.Queries.SaveAnswer(ctx, db.SaveAnswerParams{
		ID:       rec.ID,
		Mode:     rec.Mode,
		Question: rec.Question,
		Answer:   rec.Text,
		Fallback: rec.Fallback,
		Error:    rec.Error,
		Model:    rec.Model,
		Turns:    int32(rec.Turns),
		Timings:  object(rec.Timings),
		Guard:    object(rec.Guard),
	})
}

// CreateLead сохраняет заявку. Занятый номер отдаётся как
// leaduc.ErrCodeTaken — сервис попробует другой.
func (s *Store) CreateLead(ctx context.Context, l *lead.Lead) error {
	messages, err := json.Marshal(l.Messages)
	if err != nil {
		return err
	}
	if l.Messages == nil {
		messages = []byte("[]")
	}
	row, err := s.Queries.CreateLead(ctx, db.CreateLeadParams{
		Code:     l.Code,
		Name:     l.Name,
		Phone:    l.Phone,
		Company:  l.Company,
		Comment:  l.Comment,
		Summary:  l.Summary,
		Messages: messages,
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == pgerrcode.UniqueViolation && pgErr.ConstraintName == "leads_code_uq" {
		return leaduc.ErrCodeTaken
	}
	if err != nil {
		return err
	}
	l.ID, l.CreatedAt = row.ID, row.CreatedAt
	return nil
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
