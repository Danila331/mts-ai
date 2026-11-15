package usecase

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/privacy"
)

type fakeStore struct {
	locked  bool
	got     privacy.Cutoffs
	err     error
	subject privacy.Subject
	dryRun  bool
}

func (f *fakeStore) Purge(_ context.Context, c privacy.Cutoffs) (privacy.Counts, bool, error) {
	f.got = c
	return privacy.Counts{Leads: 2, Answers: 3}, f.locked, f.err
}

func (f *fakeStore) Forget(_ context.Context, s privacy.Subject, dryRun bool) (privacy.Counts, error) {
	f.subject, f.dryRun = s, dryRun
	return privacy.Counts{Leads: 1}, nil
}

func TestRetentionOnce(t *testing.T) {
	now := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	store := &fakeStore{locked: true}
	var seen privacy.Counts
	r := NewRetention(store, privacy.Policy{Leads: 24 * time.Hour}, time.Hour, zerolog.Nop(),
		func(n privacy.Counts) { seen = n })
	r.now = func() time.Time { return now }

	n, err := r.Once(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(5), n.Total())
	assert.Equal(t, n, seen, "метрики видят то же, что удалено")
	assert.Equal(t, now.Add(-24*time.Hour), store.got.Leads)

	store.locked = false
	seen = privacy.Counts{}
	n, err = r.Once(context.Background())
	require.NoError(t, err)
	assert.Zero(t, n.Total(), "без блокировки — проход другой реплики, своего нет")
	assert.Zero(t, seen.Total())

	store.err = errors.New("база лежит")
	_, err = r.Once(context.Background())
	assert.Error(t, err)
}

func TestRunStopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		NewRetention(&fakeStore{locked: true}, privacy.Policy{}, time.Hour, zerolog.Nop(), nil).Run(ctx)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("очистка не остановилась по отмене")
	}
}

func TestForgetValidatesAndDefaultsToDryRun(t *testing.T) {
	store := &fakeStore{}
	_, err := Forget(context.Background(), store, "12", "", true)
	assert.Error(t, err)

	_, err = Forget(context.Background(), store, "+7 900 123-45-67", "", true)
	require.NoError(t, err)
	assert.Equal(t, "9001234567", store.subject.Phone10)
	assert.True(t, store.dryRun)
}
