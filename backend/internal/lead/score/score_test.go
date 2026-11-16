package score

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/passport"
)

// kbDir — база знаний в корне репозитория.
const kbDir = "../../../../knowledge-base"

func squash(s string) string { return strings.Join(strings.Fields(s), " ") }

// kbSection — текст раздела документа базы до следующего заголовка того же
// или более высокого уровня.
func kbSection(t *testing.T, doc, title string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(kbDir, doc))
	require.NoError(t, err)
	re := regexp.MustCompile(`(?m)^(#{1,4}) ` + regexp.QuoteMeta(title) + `\s*$`)
	loc := re.FindSubmatchIndex(raw)
	require.NotNil(t, loc, "в %s нет раздела «%s»", doc, title)
	level := loc[3] - loc[2]
	rest := string(raw[loc[1]:])
	next := regexp.MustCompile(`(?m)^#{1,` + string(rune('0'+level)) + `} `).FindStringIndex(rest)
	if next != nil {
		rest = rest[:next[0]]
	}
	return squash(rest)
}

// Ограничение №1 ROADMAP: пороги и формулировки правил — из текста базы.
func TestRulesQuoteKnowledgeBase(t *testing.T) {
	for _, q := range KBQuotes {
		assert.Contains(t, kbSection(t, q.Doc, q.Section), squash(q.Quote), "%s, «%s»", q.Doc, q.Section)
	}

	wholesale := kbSection(t, "00-reference/02-product-scope-and-limits.md", "Выход на оптовый рынок")
	assert.Equal(t, 750.0, float64(wholesaleMinKW))
	assert.Contains(t, wholesale, "Ниже 750 кВт")
	assert.Equal(t, 20_000.0, float64(wholesaleDirectKW), "20 МВт в кВт")
	assert.Contains(t, wholesale, "От 20 МВт")
	assert.Equal(t, 1e6, float64(wholesaleWorthKWh))
	assert.Contains(t, wholesale, "от 1 млн кВт·ч в месяц")
	for _, r := range isolatedRegions {
		assert.Contains(t, wholesale, r.Name)
		assert.True(t, strings.HasPrefix(strings.ToLower(r.Name), r.Stem), r.Name)
	}

	// Каждое поле, которое попадает в «что спросить», — из чек-листа базы
	// (каталог T2); здесь — что продуктовые чек-листы в базе на месте.
	for _, title := range []string{"Для первичного понимания задачи", "Для анализа затрат и выхода на оптовый рынок",
		"Для солнечной станции", "Для платформы учёта", "Для поиска коммерческих потерь", "Для распознавания показаний"} {
		assert.NotEmpty(t, kbSection(t, "00-reference/03-calculation-and-requests.md", title))
	}
}

func pass(product passport.Group, values map[string]string, agreed bool) passport.Passport {
	p := passport.Passport{Values: map[string]passport.Value{}}
	for _, prod := range passport.Products {
		if prod.Group == product {
			p.AddSections([]passport.SectionRef{{ID: "kb-1", Doc: prod.Doc}})
		}
	}
	now := time.Now()
	for k, v := range values {
		p.Set(k, v, passport.FromBot, now)
	}
	p.HandoffAgreed = agreed
	return p
}

func says(texts ...string) []dialog.Turn {
	var turns []dialog.Turn
	for _, t := range texts {
		turns = append(turns, dialog.Turn{Role: dialog.RoleUser, Content: t},
			dialog.Turn{Role: dialog.RoleAssistant, Content: "Сколько стоит — подскажет расчёт."})
	}
	return turns
}

func TestScoreTable(t *testing.T) {
	wholesaleFull := map[string]string{
		"org_type": "машиностроительный завод", "region": "Тверская область",
		"connected_power": "5 МВт", "monthly_consumption": "около 2 млн кВт·ч", "consumption_profile": "круглосуточный",
		"voltage_class": "СН-2", "supplier": "гарантирующий поставщик", "price_category": "третья",
		"supply_points": "две точки поставки, учёт есть",
	}
	kamchatka := map[string]string{}
	for k, v := range wholesaleFull {
		kamchatka[k] = v
	}
	kamchatka["region"] = "Камчатский край"

	for _, tc := range []struct {
		name    string
		in      Input
		grade   Grade
		points  int
		reasons []string
		missing []string
	}{
		{
			name:  "оптовый рынок: всё заполнено, спрашивал про расчёт",
			in:    Input{Passport: pass(passport.Wholesale, wholesaleFull, false), Turns: says("Сколько стоит расчёт выхода на опт?"), Agreed: true},
			grade: Hot, points: 100,
			reasons: []string{
				"Подходит: Оптовый рынок и анализ затрат",
				"Мощность от 750 кВт и менее 20 МВт — участие через энергосбытовую компанию-посредника",
				"Потребление от 1 млн кВт·ч в месяц — ориентир экономической целесообразности",
				"Заполнено 7 из 7 полей для «Оптовый рынок и анализ затрат»",
				"Спрашивал про расчёт, стоимость или сроки",
				"Сам попросил связаться",
				"Назвал объём: присоединённая мощность — 5 МВт",
			},
			missing: []string{},
		},
		{
			name:  "оптовый рынок ниже 750 кВт",
			in:    Input{Passport: pass(passport.Wholesale, map[string]string{"connected_power": "300 кВт"}, false), Agreed: true},
			grade: Cold, points: 25,
			reasons: []string{
				"Не подходит: присоединённая мощность ниже 750 кВт — выход на оптовый рынок невозможен",
				"Заполнено 1 из 7 полей для «Оптовый рынок и анализ затрат»",
				"Сам попросил связаться",
				"Назвал объём: присоединённая мощность — 300 кВт",
			},
			missing: []string{"месячное потребление", "профиль потребления", "класс напряжения", "текущий поставщик",
				"ценовая категория", "точки поставки и состояние учёта", "регион"},
		},
		{
			name:  "оптовый рынок в изолированной энергосистеме — не горячая, сколько бы баллов ни набрала",
			in:    Input{Passport: pass(passport.Wholesale, kamchatka, false), Turns: says("Какие сроки?"), Agreed: true},
			grade: Warm, points: 70,
			reasons: []string{
				"Не подходит: регион в изолированной энергосистеме (Камчатка) — оптовый рынок там не функционирует",
				"Мощность от 750 кВт и менее 20 МВт — участие через энергосбытовую компанию-посредника",
			},
			missing: []string{},
		},
		{
			name: "платформа учёта: три склада, 40 счётчиков, телефон не оставил (демо-вопрос 18)",
			in: Input{
				Passport: pass(passport.Platform, map[string]string{"org_type": "склад", "meters": "около 40 счётчиков", "metering_goal": "по объектам"}, false),
				Turns:    says("У нас три склада, около 40 счётчиков, но я не готов оставлять телефон"),
			},
			grade: Warm, points: 70,
			reasons: []string{"Подходит: Платформа учёта", "Заполнено 3 из 4 полей для «Платформа учёта»",
				"Назвал объём: количество и тип приборов — около 40 счётчиков"},
			missing: []string{"схема сбора данных"},
		},
		{
			name: "солнечная станция на частном доме",
			in: Input{Passport: pass(passport.Solar, map[string]string{"object_type": "частный жилой дом", "region": "Краснодарский край"}, false),
				Agreed: true},
			grade: Cold, points: 23,
			reasons: []string{"Не подходит: частные жилые дома не входят в целевой сегмент солнечных станций",
				"Заполнено 2 из 6 полей для «Солнечная станция»", "Сам попросил связаться"},
			missing: []string{"площадь и тип кровли или площадки", "присоединённая мощность", "профиль потребления", "задача"},
		},
		{
			name: "солнечная станция на складе с шиферной кровлей",
			in: Input{Passport: pass(passport.Solar, map[string]string{
				"region": "Ростовская область", "object_type": "склад", "site_area": "шиферная кровля, 2000 м²",
				"connected_power": "400 кВт", "consumption_profile": "в основном днём", "task": "снижение платежа",
			}, true), Turns: says("За сколько окупится станция?")},
			grade: Hot, points: 100,
			reasons: []string{"Подходит: Солнечная станция",
				"Шиферная кровля: монтаж на старой шиферной кровле в материалах назван экономически сомнительным",
				"Заполнено 6 из 6 полей для «Солнечная станция»"},
			missing: []string{"возраст шиферной кровли"},
		},
		{
			name: "поиск потерь для завода — это платформа учёта",
			in: Input{Passport: pass(passport.Losses, map[string]string{"org_type": "машиностроительный завод"}, false),
				Agreed: true},
			grade: Cold, points: 10,
			reasons: []string{"Не подходит: для контроля собственного потребления предприятия предназначена платформа учёта, а не поиск потерь",
				"Заполнено 0 из 1 полей для «Поиск коммерческих потерь»"},
			missing: []string{"выгрузка данных учёта"},
		},
		{
			name: "поиск потерь для сбытовой компании — спросить про сеть на балансе",
			in: Input{Passport: pass(passport.Losses, map[string]string{"org_type": "энергосбытовая компания",
				"metering_data": "суточные данные день/ночь за два года"}, false), Turns: says("Сколько стоит?"), Agreed: true},
			grade: Hot, points: 90,
			reasons: []string{"Подходит: Поиск коммерческих потерь", "Заполнено 1 из 1 полей для «Поиск коммерческих потерь»"},
			missing: []string{"есть ли на балансе сетевая организация"},
		},
		{
			name: "распознавание показаний тепла — доработка",
			in: Input{Passport: pass(passport.Recognition, map[string]string{"resource_type": "тепло", "meter_fleet": "500 квартирных теплосчётчиков"}, false),
				Agreed: true},
			grade: Warm, points: 60,
			reasons: []string{"Подходит: Распознавание показаний", "Тепло и газ — отдельная доработка, а не готовая функция",
				"Заполнено 2 из 4 полей для «Распознавание показаний»"},
			missing: []string{"способ передачи изображений", "объём потока или архива фото"},
		},
		{
			name:  "просто интересуюсь, продукт не определён",
			in:    Input{Passport: passport.Passport{}, Turns: says("Просто интересуюсь, что такое ценовые категории")},
			grade: Cold, points: 0,
			reasons: []string{"Заполнено 0 из 7 полей общих сведений",
				"Минус: клиент сказал, что просто интересуется",
				"Минус: продукт и задача не определены — вопрос вне продуктов базы или задача не названа"},
			missing: []string{"тип организации", "тип объекта", "регион", "задача", "присоединённая мощность",
				"месячное потребление", "приборы учёта и сбор показаний"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := Of(tc.in)
			assert.Equal(t, tc.grade, s.Grade)
			assert.Equal(t, tc.points, s.Points, "%v", s.Reasons)
			for _, r := range tc.reasons {
				assert.Contains(t, s.Reasons, r)
			}
			assert.Equal(t, tc.missing, s.Missing)
		})
	}
}

func TestScoreIgnoresAssistantWords(t *testing.T) {
	// Бот сказал «сколько стоит» — это не намерение клиента.
	s := Of(Input{Passport: pass(passport.Platform, nil, false), Turns: says("Нужен учёт по арендаторам")})
	assert.NotContains(t, s.Reasons, "Спрашивал про расчёт, стоимость или сроки")
}

func TestPowerAndEnergy(t *testing.T) {
	for in, want := range map[string]float64{
		"800 кВт": 800, "1,2 МВт": 1200, "около 2 мегаватт": 2000, "1 200 кВт": 1200, "0.5 мвт": 500,
	} {
		got, ok := PowerKW(in)
		assert.True(t, ok, in)
		assert.InDelta(t, want, got, 0.01, in)
	}
	for _, in := range []string{"", "много", "1 млн кВт·ч", "300 кВтч", "2000 м²", "800 кВт-ч"} {
		_, ok := PowerKW(in)
		assert.False(t, ok, in)
	}
	for in, want := range map[string]float64{
		"1,2 млн кВт·ч": 1.2e6, "800 тыс. кВт·ч": 8e5, "500 МВт·ч в месяц": 5e5, "300 000 кВтч": 3e5,
	} {
		got, ok := MonthlyKWh(in)
		assert.True(t, ok, in)
		assert.InDelta(t, want, got, 0.01, in)
	}
	_, ok := MonthlyKWh("много")
	assert.False(t, ok)
}
