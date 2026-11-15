// Package usecase — очистка по сроку хранения и удаление по запросу.
package usecase

import (
	"context"
	"fmt"
	"time"

	"github.com/rs/zerolog"

	"github.com/Danila331/mts-ai/backend/internal/privacy"
)

// Store — хранилище, которое умеет чистить и забывать.
type Store interface {
	// Purge удаляет записи старше границ. locked=false — очистку прямо
	// сейчас делает другая реплика, и этот проход пропущен.
	Purge(ctx context.Context, c privacy.Cutoffs) (n privacy.Counts, locked bool, err error)
	// Forget удаляет данные человека. dryRun — только посчитать: те же
	// запросы в транзакции, которая откатывается.
	Forget(ctx context.Context, s privacy.Subject, dryRun bool) (privacy.Counts, error)
}

// Retention чистит таблицы по сроку хранения раз в interval.
type Retention struct {
	store    Store
	policy   privacy.Policy
	interval time.Duration
	log      zerolog.Logger
	// observe — для метрик: сколько удалено за проход.
	observe func(privacy.Counts)
	now     func() time.Time
}

func NewRetention(store Store, policy privacy.Policy, interval time.Duration, log zerolog.Logger,
	observe func(privacy.Counts)) *Retention {
	if interval <= 0 {
		interval = time.Hour
	}
	return &Retention{store: store, policy: policy, interval: interval, log: log, observe: observe, now: time.Now}
}

// Once — один проход очистки.
func (r *Retention) Once(ctx context.Context) (privacy.Counts, error) {
	n, locked, err := r.store.Purge(ctx, r.policy.Cutoffs(r.now()))
	if err != nil {
		return privacy.Counts{}, fmt.Errorf("очистка по сроку хранения: %w", err)
	}
	if !locked {
		r.log.Debug().Msg("очистку делает другая реплика — проход пропущен")
		return privacy.Counts{}, nil
	}
	if r.observe != nil {
		r.observe(n)
	}
	event := r.log.Debug()
	if n.Total() > 0 {
		event = r.log.Info()
	}
	event.Int64("leads", n.Leads).Int64("answers", n.Answers).Int64("feedback", n.Feedback).
		Msg("очистка по сроку хранения")
	return n, nil
}

// Run чистит сразу и затем раз в interval, пока ctx не отменён. Сбой
// прохода не останавливает следующие: база могла просто перезапуститься.
func (r *Retention) Run(ctx context.Context) {
	t := time.NewTicker(r.interval)
	defer t.Stop()
	for {
		pass, cancel := context.WithTimeout(ctx, 2*time.Minute)
		if _, err := r.Once(pass); err != nil && ctx.Err() == nil {
			r.log.Error().Err(err).Msg("очистка по сроку хранения не прошла")
		}
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Forget удаляет данные человека по его запросу.
func Forget(ctx context.Context, store Store, phone, leadCode string, dryRun bool) (privacy.Counts, error) {
	s, err := privacy.NewSubject(phone, leadCode)
	if err != nil {
		return privacy.Counts{}, err
	}
	return store.Forget(ctx, s, dryRun)
}
