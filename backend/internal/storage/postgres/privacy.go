package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/Danila331/mts-ai/backend/internal/privacy"
	"github.com/Danila331/mts-ai/backend/internal/storage/postgres/db"
)

// errDryRun откатывает транзакцию пробного удаления.
var errDryRun = errors.New("пробный прогон")

// Purge удаляет записи старше границ в одной транзакции под
// транзакционной блокировкой: две реплики не чистят одновременно.
func (s *Store) Purge(ctx context.Context, c privacy.Cutoffs) (privacy.Counts, bool, error) {
	var (
		n      privacy.Counts
		locked bool
	)
	err := s.inTx(ctx, func(q *db.Queries) error {
		var err error
		if locked, err = q.TryRetentionLock(ctx); err != nil || !locked {
			return err
		}
		if !c.Answers.IsZero() {
			if n.Answers, err = q.PurgeAnswers(ctx, c.Answers); err != nil {
				return fmt.Errorf("answers: %w", err)
			}
		}
		if !c.Leads.IsZero() {
			if n.Leads, err = q.PurgeLeads(ctx, c.Leads); err != nil {
				return fmt.Errorf("leads: %w", err)
			}
		}
		if !c.Feedback.IsZero() {
			if n.Feedback, err = q.PurgeFeedback(ctx, c.Feedback); err != nil {
				return fmt.Errorf("feedback: %w", err)
			}
		}
		return nil
	})
	return n, locked, err
}

// Forget удаляет заявки человека и записи, где упомянут его номер. Всё —
// одной транзакцией: удаление по запросу либо полное, либо никакого.
func (s *Store) Forget(ctx context.Context, subj privacy.Subject, dryRun bool) (privacy.Counts, error) {
	var n privacy.Counts
	err := s.inTx(ctx, func(q *db.Queries) error {
		if subj.LeadCode != "" {
			rows, err := q.ForgetLeadByCode(ctx, subj.LeadCode)
			if err != nil {
				return fmt.Errorf("заявка по номеру: %w", err)
			}
			n.Leads += rows
		}
		if subj.Phone10 != "" {
			steps := []struct {
				name string
				dst  *int64
				run  func(context.Context, string) (int64, error)
			}{
				{"заявки по телефону", &n.Leads, q.ForgetLeadsByPhone},
				{"заявки с номером в тексте", &n.Leads, q.ForgetLeadsMentioning},
				{"ответы с номером", &n.Answers, q.ForgetAnswersMentioning},
				{"оценки с номером", &n.Feedback, q.ForgetFeedbackMentioning},
			}
			for _, st := range steps {
				rows, err := st.run(ctx, subj.Phone10)
				if err != nil {
					return fmt.Errorf("%s: %w", st.name, err)
				}
				*st.dst += rows
			}
		}
		if dryRun {
			return errDryRun
		}
		return nil
	})
	if errors.Is(err, errDryRun) {
		err = nil
	}
	return n, err
}

// inTx выполняет fn в транзакции: ошибка — откат, иначе фиксация.
func (s *Store) inTx(ctx context.Context, fn func(*db.Queries) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(s.Queries.WithTx(tx)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
