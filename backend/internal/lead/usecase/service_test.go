package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/ai/llm"
	"github.com/Danila331/mts-ai/backend/internal/lead"
)

type repo struct {
	saved []lead.Lead
	taken int // сколько первых попыток упрётся в занятый номер
}

func (r *repo) CreateLead(_ context.Context, l *lead.Lead) error {
	if r.taken > 0 {
		r.taken--
		return ErrCodeTaken
	}
	r.saved = append(r.saved, *l)
	return nil
}

type model struct {
	text string
	err  error
	got  []llm.Message
}

func (m *model) Configured() bool { return true }
func (m *model) Chat(_ context.Context, msgs []llm.Message, _ int) (string, error) {
	m.got = msgs
	return m.text, m.err
}

const dialogJSON = `[{"role":"user","content":"Нужен АСКУЭ"},{"role":"assistant","content":"Подскажу"}]`

func TestCreateWithModelSummary(t *testing.T) {
	r, m := &repo{taken: 1}, &model{text: "Задача клиента: АСКУЭ"}
	l, err := New(r, m, zerolog.Nop()).Create(context.Background(),
		lead.Contacts{Name: "  Иван  ", Phone: strings.Repeat("1", 80)}, json.RawMessage(dialogJSON))
	require.NoError(t, err)

	assert.Equal(t, "Задача клиента: АСКУЭ", l.Summary)
	assert.Equal(t, "Иван", l.Name)
	assert.Len(t, l.Phone, lead.MaxPhone)
	assert.Len(t, l.Code, 10)
	assert.Len(t, r.saved, 1, "занятый номер — повтор, а не отказ")
	assert.Equal(t, "ДИАЛОГ\nКлиент: Нужен АСКУЭ\nКонсультант: Подскажу", m.got[1].Content)
}

func TestCreateFallsBackWithoutModel(t *testing.T) {
	r := &repo{}
	l, err := New(r, &model{err: errors.New("down")}, zerolog.Nop()).Create(context.Background(),
		lead.Contacts{}, json.RawMessage(dialogJSON))
	require.NoError(t, err)
	assert.Equal(t, "Вопросы клиента: Нужен АСКУЭ", l.Summary)

	l, err = New(r, nil, zerolog.Nop()).Create(context.Background(), lead.Contacts{}, json.RawMessage(`[]`))
	require.NoError(t, err)
	assert.Equal(t, "Диалога не было.", l.Summary)
}

func TestCreateRejectsBadMessages(t *testing.T) {
	_, err := New(&repo{}, nil, zerolog.Nop()).Create(context.Background(), lead.Contacts{}, nil)
	require.Error(t, err)
}
