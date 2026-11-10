// Package usecase принимает оценку ответа.
package usecase

import (
	"context"
	"fmt"

	"github.com/Danila331/mts-ai/backend/internal/feedback"
)

// Repository — куда ложатся оценки.
type Repository interface {
	CreateFeedback(ctx context.Context, f feedback.Feedback) error
}

type Service struct{ repo Repository }

func New(repo Repository) *Service { return &Service{repo: repo} }

// Rate сохраняет оценку. rating приходит числом как есть: проверка —
// дело предмета, а не транспорта.
func (s *Service) Rate(ctx context.Context, f feedback.Feedback, rating int) error {
	r, err := feedback.ParseRating(rating)
	if err != nil {
		return err
	}
	f.Rating = r
	if err := s.repo.CreateFeedback(ctx, f.Normalize()); err != nil {
		return fmt.Errorf("сохранить оценку: %w", err)
	}
	return nil
}
