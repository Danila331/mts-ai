package passport

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/dialog"
)

func TestNormalizePhone(t *testing.T) {
	for in, want := range map[string]string{
		"+7 900 000-00-00":   "+79000000000",
		"8 (900) 000-00-00":  "+79000000000",
		"89000000000":        "+79000000000",
		"79000000000":        "+79000000000",
		"9000000000":         "+79000000000",
		"+7(900)000 00 00":   "+79000000000",
		"8-900-000-00-00":    "+79000000000",
		"+7 900 000 00 00":   "+79000000000",
		"900.000.00.00":      "+79000000000",
		"+7 (900) 000-00-00": "+79000000000",
	} {
		got, ok := NormalizePhone(in)
		assert.True(t, ok, in)
		assert.Equal(t, want, got, in)
	}
	for _, bad := range []string{"", "12345", "+1 900 000 00 00", "59000000000", "900000000000", "tel: 900", "+7 900 000-00-0"} {
		_, ok := NormalizePhone(bad)
		assert.False(t, ok, bad)
	}
}

func TestCleanAndSet(t *testing.T) {
	v, err := Clean("task", "Поиск потерь")
	require.NoError(t, err)
	assert.Equal(t, "поиск потерь", v, "задача — ровно как в базе")
	_, err = Clean("task", "майнинг")
	assert.Error(t, err)
	_, err = Clean("nonsense", "x")
	assert.Error(t, err, "полей вне чек-листов базы нет")
	_, err = Clean("phone", "звоните завтра")
	assert.Error(t, err)

	var p Passport
	now := time.Now()
	p.Set("region", "Тверская область", FromClient, now)
	p.Set("region", "Москва", FromBot, now)
	assert.Equal(t, "Тверская область", p.Values["region"].Value, "правку клиента бот не перезаписывает")
	p.Set("region", "", FromClient, now)
	assert.NotContains(t, p.Values, "region", "клиент стёр поле")
}

func TestRenderProgress(t *testing.T) {
	var p Passport
	p.AddSections([]SectionRef{{ID: "a1", Doc: "20-products/22-askue.md"}, {ID: "x", Doc: "10-energy/13-metering.md"}})
	p.AddSections([]SectionRef{{ID: "a1", Doc: "20-products/22-askue.md"}, {ID: "a2", Doc: "20-products/22-askue.md"}})
	p.Set("meters", "около 40 счётчиков", FromBot, time.Now())
	v := p.Render()
	assert.Equal(t, Platform, v.Product)
	assert.Equal(t, []string{"a1", "a2"}, v.Products[0].Sections)
	assert.Equal(t, 1, v.Filled)
	assert.Equal(t, len(Required[Platform]), v.Total)
	assert.False(t, v.ReadyForLead)
	for _, k := range []string{"name", "phone", "company"} {
		p.Set(k, "x", FromBot, time.Now())
	}
	assert.True(t, p.Render().ReadyForLead)
}

type fakeModel struct {
	out string
	err error
}

func (m fakeModel) Configured() bool { return true }
func (m fakeModel) Complete(context.Context, string, string, int) (string, error) {
	return m.out, m.err
}

// Демо-вопрос 18: три склада, около 40 счётчиков, телефон оставлять не готов.
var warehouses = []dialog.Turn{
	{Role: dialog.RoleUser, Content: "У нас три склада и около 40 счётчиков, хотим собирать показания автоматически."},
	{Role: dialog.RoleAssistant, Content: "Это задача для платформы учёта. В каком регионе склады — например, Москва?"},
	{Role: dialog.RoleUser, Content: "Пока не готов оставлять телефон, просто расскажите, как это работает."},
}

func TestExtractKeepsOnlyClientWords(t *testing.T) {
	// Модель перенесла «Москва» из реплики консультанта — фильтр это ловит.
	m := fakeModel{out: "Вот паспорт:\n" + `{"fields": {"object_type": "три склада", "meters": "около 40 счётчиков",
		"region": "Москва", "connected_power": "150 кВт", "task": "автоматизация учёта", "phone": null},
		"handoff_agreed": false}`}
	u, err := Extract(context.Background(), m, warehouses)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{
		"object_type": "три склада", "meters": "около 40 счётчиков", "task": "автоматизация учёта",
	}, u.Values)
	assert.ElementsMatch(t, []string{"region", "connected_power"}, u.Dropped)
	assert.False(t, u.HandoffAgreed)

	var p Passport
	for k, v := range u.Values {
		p.Set(k, v, FromBot, time.Now())
	}
	assert.False(t, p.Render().ReadyForLead, "контактов нет — заявки нет, консультация продолжается")
}

func TestExtractContactsFromChat(t *testing.T) {
	turns := []dialog.Turn{
		{Role: dialog.RoleUser, Content: "Да, передайте менеджеру. Тестов Тест, +7 900 000 00 00, ООО Учебный склад"},
	}
	m := fakeModel{out: `{"fields": {"name": "Тестов Тест", "phone": "+7 900 000-00-00", "company": "ООО Учебный склад"},
		"handoff_agreed": true}`}
	u, err := Extract(context.Background(), m, turns)
	require.NoError(t, err)
	assert.Equal(t, "+79000000000", u.Values["phone"])
	assert.Equal(t, "Тестов Тест", u.Values["name"])
	assert.Equal(t, "ООО Учебный склад", u.Values["company"])
	assert.True(t, u.HandoffAgreed)
}

func TestExtractWithoutModelOrOnFailure(t *testing.T) {
	turns := []dialog.Turn{{Role: dialog.RoleUser, Content: "мой номер 8 900 000-00-00"}}
	u, err := Extract(context.Background(), nil, turns)
	require.NoError(t, err)
	assert.Equal(t, map[string]string{"phone": "+79000000000"}, u.Values, "телефон находится и без модели")

	u, err = Extract(context.Background(), fakeModel{err: errors.New("503")}, turns)
	assert.Error(t, err)
	assert.Equal(t, "+79000000000", u.Values["phone"], "сбой модели не стирает найденное кодом")

	_, err = Extract(context.Background(), fakeModel{out: "не знаю"}, turns)
	assert.ErrorIs(t, err, errNoJSON)
}

// QA: опора ответа случайно задела документ распознавания по фото, а клиент
// говорит об автоматизации учёта — прогресс считается для платформы учёта.
func TestPrimaryProductByTaskThenSections(t *testing.T) {
	var p Passport
	p.AddSections([]SectionRef{{ID: "r1", Doc: "20-products/25-meter-reading.md"}, {ID: "r2", Doc: "20-products/25-meter-reading.md"}})
	assert.Equal(t, Recognition, p.Render().Product, "без задачи — по опоре")
	p.Set("task", "автоматизация учёта", FromBot, time.Now())
	assert.Equal(t, Platform, p.Render().Product, "задача клиента главнее случайной опоры")
	assert.Equal(t, "Платформа учёта", p.Render().ProductLabel)

	var q Passport
	q.AddSections([]SectionRef{{ID: "s1", Doc: "20-products/23-solar.md"}})
	q.AddSections([]SectionRef{{ID: "a1", Doc: "20-products/22-askue.md"}, {ID: "a2", Doc: "20-products/22-askue.md"}})
	assert.Equal(t, Platform, q.Render().Product, "больше разделов — главнее первого упомянутого")
}
