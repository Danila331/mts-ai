package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/lead"
)

type repo struct {
	saved     []lead.Lead
	taken     int   // сколько первых попыток упрётся в занятый номер
	createErr error // база недоступна
	updateErr error
}

func (r *repo) CreateLead(_ context.Context, l *lead.Lead) error {
	if r.createErr != nil {
		return r.createErr
	}
	if r.taken > 0 {
		r.taken--
		return lead.ErrCodeTaken
	}
	r.saved = append(r.saved, *l)
	return nil
}

func (r *repo) UpdateLeadSummary(_ context.Context, l *lead.Lead) error {
	if r.updateErr != nil {
		return r.updateErr
	}
	for i := range r.saved {
		if r.saved[i].Code == l.Code {
			r.saved[i].Summary, r.saved[i].SummarySource = l.Summary, l.SummarySource
		}
	}
	return nil
}

type model struct {
	text   string
	err    error
	calls  int
	system string
	user   string
}

func (m *model) Configured() bool { return true }
func (m *model) Complete(_ context.Context, system, user string, _ int) (string, error) {
	m.calls++
	m.system, m.user = system, user
	return m.text, m.err
}

const dialogJSON = `[{"role":"user","content":"Нужен АСКУЭ"},{"role":"assistant","content":"Подскажу"}]`

func TestCreateWithModelSummary(t *testing.T) {
	r, m := &repo{taken: 1}, &model{text: "Задача клиента: АСКУЭ"}
	l, err := New(r, m).Create(context.Background(),
		lead.Contacts{Name: "  Иван  ", Phone: strings.Repeat("1", 80)}, json.RawMessage(dialogJSON))
	require.NoError(t, err)

	assert.Equal(t, "Задача клиента: АСКУЭ", l.Summary)
	assert.Equal(t, lead.SummaryLLM, l.SummarySource)
	assert.Equal(t, "Иван", l.Name)
	assert.Len(t, l.Phone, lead.MaxPhone)
	assert.Len(t, l.Code, 10)
	require.Len(t, r.saved, 1, "занятый номер — повтор, а не отказ")
	assert.Equal(t, "Задача клиента: АСКУЭ", r.saved[0].Summary, "резюме моделью дописано в сохранённую заявку")
	assert.Equal(t, lead.SummaryLLM, r.saved[0].SummarySource)
	assert.Equal(t, lead.SummarySystem, m.system)
	assert.Equal(t, "ДИАЛОГ\nКлиент: Нужен АСКУЭ\nКонсультант: Подскажу", m.user)
}

func TestCreateSavesBeforeModel(t *testing.T) {
	m := &model{text: "резюме"}
	_, err := New(&repo{createErr: errors.New("база лежит")}, m).Create(context.Background(),
		lead.Contacts{}, json.RawMessage(dialogJSON))
	require.Error(t, err)
	assert.Zero(t, m.calls, "база недоступна — модель не зовётся: заявки нет, платить не за что")
}

func TestCreateKeepsDigestWhenUpdateFails(t *testing.T) {
	r := &repo{updateErr: errors.New("обрыв")}
	l, err := New(r, &model{text: "резюме моделью"}).Create(context.Background(),
		lead.Contacts{}, json.RawMessage(dialogJSON))
	require.NoError(t, err, "заявка уже в базе — клиенту успех")
	assert.Equal(t, "Вопросы клиента: Нужен АСКУЭ", l.Summary, "клиент видит то же, что менеджер")
	assert.Equal(t, lead.SummaryDigest, l.SummarySource)
	assert.Equal(t, "Вопросы клиента: Нужен АСКУЭ", r.saved[0].Summary)
}

func TestCreateFallsBackWithoutModel(t *testing.T) {
	r := &repo{}
	l, err := New(r, &model{err: errors.New("down")}).Create(context.Background(),
		lead.Contacts{}, json.RawMessage(dialogJSON))
	require.NoError(t, err)
	assert.Equal(t, "Вопросы клиента: Нужен АСКУЭ", l.Summary)
	assert.Equal(t, lead.SummaryDigest, l.SummarySource)
	assert.Equal(t, lead.SummaryDigest, r.saved[0].SummarySource, "заявка записана со списком вопросов")

	l, err = New(r, nil).Create(context.Background(), lead.Contacts{}, json.RawMessage(`[]`))
	require.NoError(t, err)
	assert.Equal(t, "Диалога не было.", l.Summary)
}

func TestCreateRejectsBadMessages(t *testing.T) {
	_, err := New(&repo{}, nil).Create(context.Background(), lead.Contacts{}, nil)
	require.Error(t, err)
}
