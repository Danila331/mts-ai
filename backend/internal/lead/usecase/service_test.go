package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/lead/score"
	"github.com/Danila331/mts-ai/backend/internal/passport"
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

// generalMissing — заявка без паспорта: спросить всё из «Для первичного
// понимания задачи».
const generalMissing = "тип организации, тип объекта, регион, задача, присоединённая мощность, месячное потребление, " +
	"приборы учёта и сбор показаний"

// kindDefault — первая строка резюме заявки по умолчанию (T17).
const kindDefault = "Тип заявки: Обратный звонок\n"

const digest = kindDefault + "Вопросы клиента: Нужен АСКУЭ\nЧто уточнить менеджеру: " + generalMissing

func TestCreateWithModelSummary(t *testing.T) {
	r, m := &repo{taken: 1}, &model{text: "Задача клиента: АСКУЭ"}
	l, err := New(r, m).Create(context.Background(),
		lead.Contacts{Name: "  Иван  ", Phone: strings.Repeat("1", 80)}, json.RawMessage(dialogJSON))
	require.NoError(t, err)

	assert.Equal(t, kindDefault+"Задача клиента: АСКУЭ", l.Summary)
	assert.Equal(t, lead.SummaryLLM, l.SummarySource)
	assert.Equal(t, "Иван", l.Name)
	assert.Len(t, l.Phone, lead.MaxPhone)
	assert.Len(t, l.Code, 10)
	require.Len(t, r.saved, 1, "занятый номер — повтор, а не отказ")
	assert.Equal(t, kindDefault+"Задача клиента: АСКУЭ", r.saved[0].Summary, "резюме моделью дописано в сохранённую заявку")
	assert.Equal(t, lead.SummaryLLM, r.saved[0].SummarySource)
	assert.Equal(t, lead.SummarySystem, m.system)
	assert.Equal(t, "ДИАЛОГ\nНЕ ЗАПОЛНЕНО (спросить на звонке): "+generalMissing+"\n\nКлиент: Нужен АСКУЭ\nКонсультант: Подскажу", m.user)
	assert.Equal(t, score.Cold, l.Score.Grade, "продукт не определён, паспорта нет")
	assert.Equal(t, l.Score, r.saved[0].Score, "оценка записана вместе с заявкой")
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
	assert.Equal(t, digest, l.Summary, "клиент видит то же, что менеджер")
	assert.Equal(t, lead.SummaryDigest, l.SummarySource)
	assert.Equal(t, digest, r.saved[0].Summary)
}

func TestCreateFallsBackWithoutModel(t *testing.T) {
	r := &repo{}
	l, err := New(r, &model{err: errors.New("down")}).Create(context.Background(),
		lead.Contacts{}, json.RawMessage(dialogJSON))
	require.NoError(t, err)
	assert.Equal(t, digest, l.Summary, "без модели «что уточнить» всё равно в резюме")
	assert.Equal(t, lead.SummaryDigest, l.SummarySource)
	assert.Equal(t, lead.SummaryDigest, r.saved[0].SummarySource, "заявка записана со списком вопросов")

	l, err = New(r, nil).Create(context.Background(), lead.Contacts{}, json.RawMessage(`[]`))
	require.NoError(t, err)
	assert.Equal(t, kindDefault+"Диалога не было.\nЧто уточнить менеджеру: "+generalMissing, l.Summary)
}

func TestCreateRejectsBadMessages(t *testing.T) {
	_, err := New(&repo{}, nil).Create(context.Background(), lead.Contacts{}, nil)
	require.Error(t, err)
}

// passports — паспорт сессии в памяти.
type passports struct{ p passport.Passport }

func (f *passports) LoadPassport(context.Context, string) (passport.Passport, error) { return f.p, nil }
func (f *passports) SavePassport(_ context.Context, _ string, p passport.Passport) error {
	f.p = p
	return nil
}

func TestCreateScoresFromSessionPassport(t *testing.T) {
	p := passport.Parse(nil)
	p.AddSections([]passport.SectionRef{{ID: "askue-1", Doc: "20-products/22-askue.md"}})
	now := time.Now()
	for k, v := range map[string]string{"org_type": "склад", "meters": "около 40 счётчиков", "metering_goal": "по объектам"} {
		p.Set(k, v, passport.FromBot, now)
	}
	r, m := &repo{}, &model{text: "Задача клиента: учёт"}
	svc := New(r, m).WithPassports(&passports{p: p})
	l, err := svc.CreateForSession(context.Background(), lead.Contacts{Name: "Тестов Тест", Phone: "+7 900 000-00-00",
		Company: "ООО Учебный склад"}, json.RawMessage(`[{"role":"user","content":"Сколько стоит учёт на трёх складах?"}]`), "sess-1")
	require.NoError(t, err)

	require.Len(t, r.saved, 1)
	sc := r.saved[0].Score
	// 30 (подходит) + 30 (3 из 4) + 10 (стоимость) + 10 (отправил заявку) + 10 (назвал объём).
	assert.Equal(t, score.Hot, sc.Grade)
	assert.Equal(t, 90, sc.Points)
	assert.Contains(t, sc.Reasons, "Подходит: Платформа учёта")
	assert.Contains(t, sc.Reasons, "Заполнено 3 из 4 полей для «Платформа учёта»")
	assert.Equal(t, []string{"схема сбора данных"}, sc.Missing)
	assert.Equal(t, sc, l.Score)
	assert.Contains(t, m.user, "НЕ ЗАПОЛНЕНО (спросить на звонке): схема сбора данных", "модель резюме знает, что уточнить")
	assert.Contains(t, m.user, "Количество и тип приборов: около 40 счётчиков", "и известные параметры паспорта")
	assert.Contains(t, lead.SummarySystem, "Известные параметры:")
}

func TestCreateKeepsCallbackPreference(t *testing.T) {
	pp := &passports{p: passport.Parse(nil)}
	r := &repo{}
	l, err := New(r, nil).WithPassports(pp).CreateForSession(context.Background(), lead.Contacts{
		Name: "Тестов Тест", Phone: "+7 900 000-00-00",
		Callback: lead.Callback{Time: "evening", Timezone: "Asia/Yekaterinburg"},
	}, json.RawMessage(dialogJSON), "sess-1")
	require.NoError(t, err)
	assert.Equal(t, lead.Callback{Time: "evening", Timezone: "Asia/Yekaterinburg"}, r.saved[0].Callback)
	assert.True(t, strings.HasSuffix(l.Summary, "\nУдобное время для звонка: вечер, Екатеринбург (UTC+5)"), l.Summary)
	v := pp.p.Values["callback_preference"]
	assert.Equal(t, "вечер, Екатеринбург (UTC+5)", v.Value, "предпочтение видно в паспорте")
	assert.Equal(t, passport.FromClient, v.Source, "его выбрал клиент")

	// С моделью строка про время остаётся: её выбрал клиент, а не пересказала модель.
	r2 := &repo{}
	l, err = New(r2, &model{text: "Задача клиента: учёт"}).Create(context.Background(),
		lead.Contacts{Callback: lead.Callback{Time: "morning"}}, json.RawMessage(dialogJSON))
	require.NoError(t, err)
	assert.Equal(t, kindDefault+"Задача клиента: учёт\nУдобное время для звонка: утро", l.Summary)

	_, err = New(&repo{}, nil).Create(context.Background(), lead.Contacts{Callback: lead.Callback{Time: "в 15:00"}},
		json.RawMessage(dialogJSON))
	require.Error(t, err, "точное время — не вариант выбора")
}

func TestCreateKindFollowsPassportProducts(t *testing.T) {
	ctx := context.Background()
	contacts := func(k lead.Kind) lead.Contacts {
		return lead.Contacts{Name: "Тестов Тест", Phone: "+7 900 000-00-00", Company: "ООО Учебный склад", Kind: k}
	}
	withProduct := func(doc string) *passports {
		p := passport.Parse(nil)
		p.AddSections([]passport.SectionRef{{ID: "kb-1", Doc: doc}})
		return &passports{p: p}
	}

	// Солнечная станция: демо-кабинета и пилота нет — отказ до записи.
	r := &repo{}
	solar := withProduct("20-products/23-solar.md")
	for _, k := range []lead.Kind{lead.KindDemo, lead.KindPilot} {
		_, err := New(r, nil).WithPassports(solar).CreateForSession(ctx, contacts(k), json.RawMessage(dialogJSON), "sess-solar")
		require.Error(t, err, k)
		assert.Contains(t, err.Error(), "только для платформы учёта")
	}
	assert.Empty(t, r.saved, "неподходящий тип — заявки нет")
	assert.Empty(t, solar.p.Values, "и паспорт не тронут")
	l, err := New(r, nil).WithPassports(solar).CreateForSession(ctx, contacts(lead.KindAssessment), json.RawMessage(dialogJSON), "sess-solar")
	require.NoError(t, err)
	assert.Equal(t, lead.KindAssessment, r.saved[0].Kind)
	assert.True(t, strings.HasPrefix(l.Summary, "Тип заявки: Бесплатная предварительная оценка\n"), l.Summary)

	// Платформа учёта: все четыре.
	for _, k := range []lead.Kind{lead.KindCallback, lead.KindAssessment, lead.KindDemo, lead.KindPilot} {
		r := &repo{}
		l, err := New(r, &model{text: "Задача клиента: учёт"}).WithPassports(withProduct("20-products/22-askue.md")).
			CreateForSession(ctx, contacts(k), json.RawMessage(dialogJSON), "sess-askue")
		require.NoError(t, err, k)
		assert.Equal(t, k, r.saved[0].Kind)
		assert.True(t, strings.HasPrefix(l.Summary, "Тип заявки: "+k.Label()+"\n"), "тип виден менеджеру в резюме: %q", l.Summary)
	}

	// Без сессии продукт неизвестен — только общие типы; пустой тип — звонок.
	_, err = New(&repo{}, nil).Create(ctx, contacts(lead.KindDemo), json.RawMessage(dialogJSON))
	require.Error(t, err)
	_, err = New(&repo{}, nil).Create(ctx, contacts("meeting"), json.RawMessage(dialogJSON))
	require.Error(t, err, "неизвестный тип — отказ")
	r = &repo{}
	_, err = New(r, nil).Create(ctx, contacts(""), json.RawMessage(dialogJSON))
	require.NoError(t, err)
	assert.Equal(t, lead.KindCallback, r.saved[0].Kind)
}
