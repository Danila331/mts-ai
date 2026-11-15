// Package score — оценка заявки «горячая / тёплая / холодная» с
// объяснением.
//
// Правила детерминированные, а не модель: оценку должно быть можно
// объяснить менеджеру и воспроизвести на тех же данных. Каждое правило
// опирается на раздел базы знаний (путь и заголовок — в комментарии), а
// пороги и формулировки, на которых правило держится, перечислены в
// KBQuotes: тест сверяет их с текстом базы (глобальное ограничение №1
// docs/ROADMAP.md). Баллы и границы оценок — внутренняя шкала сортировки
// заявок, а не факт о продукте: клиенту они не показываются.
package score

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/passport"
)

// Grade — оценка заявки.
type Grade string

const (
	Hot  Grade = "hot"
	Warm Grade = "warm"
	Cold Grade = "cold"
)

// Score — оценка заявки для менеджера.
type Score struct {
	Grade  Grade `json:"grade"`
	Points int   `json:"points"`
	// Reasons — из чего сложилась оценка, по-русски: «Подходит: …»,
	// «Заполнено 5 из 7 полей …», «Минус: …».
	Reasons []string `json:"reasons"`
	// Missing — что спросить менеджеру на звонке: незаполненные поля
	// чек-листа продукта и уточнения к границам продукта.
	Missing []string `json:"missing"`
	// Product — продукт, по чек-листу которого считалась полнота.
	Product passport.Group `json:"product"`
}

// Input — из чего считается оценка.
type Input struct {
	Passport passport.Passport
	// Turns — диалог: признаки намерения ищутся только в репликах клиента.
	Turns []dialog.Turn
	// Agreed — клиент сам попросил связаться: отправил заявку с согласием
	// или согласился на передачу в чате.
	Agreed bool
}

// Шкала: 30 баллов за соответствие, 40 — за полноту, 30 — за намерение;
// минусы вычитаются. Противоречие границам продукта не даёт оценку «горячая».
const (
	pointsFit      = 30 // продукт определён, и паспорт не противоречит его границам
	pointsComplete = 40 // весь чек-лист продукта заполнен
	pointsIntent   = 10 // за каждый из трёх признаков намерения
	penaltyCasual  = 30 // «просто интересуюсь»
	penaltyOffTask = 20 // продукт и задача не определены
	// hotFrom — горячая: подходит, чек-лист заполнен хотя бы наполовину и
	// есть хотя бы один признак намерения сверх самой заявки.
	hotFrom  = 75
	warmFrom = 40
)

// Пороги и перечни из базы. Значения — ровно те, что в тексте базы (см.
// KBQuotes и тест).
const (
	// 00-reference/02-product-scope-and-limits.md, «Выход на оптовый рынок»:
	// «Ниже 750 кВт присоединённой мощности выход на оптовый рынок невозможен».
	wholesaleMinKW = 750
	// Там же: «От 20 МВт возможно прямое участие».
	wholesaleDirectKW = 20_000
	// Там же: «Потребление от 1 млн кВт·ч в месяц — ориентир экономической
	// целесообразности, а не формальный порог допуска».
	wholesaleWorthKWh = 1_000_000
)

// isolatedRegions — 00-reference/02-product-scope-and-limits.md, «Выход на
// оптовый рынок»: «В изолированных энергосистемах, указанных в материалах
// (Камчатка, Магадан, Сахалин, Чукотка), оптовый рынок не функционирует».
// Stem — основа слова: «Камчатский край», «Магаданская область».
var isolatedRegions = []struct{ Name, Stem string }{
	{"Камчатка", "камчат"},
	{"Магадан", "магадан"},
	{"Сахалин", "сахалин"},
	{"Чукотка", "чукот"},
}

// KBQuote — формулировка базы, на которой держится правило.
type KBQuote struct {
	Doc, Section, Quote string
}

// KBQuotes — все формулировки базы, на которые опираются правила. Тест
// проверяет, что каждая есть в своём разделе дословно (с точностью до
// переносов строк).
var KBQuotes = []KBQuote{
	{"00-reference/02-product-scope-and-limits.md", "Выход на оптовый рынок",
		"Ниже 750 кВт присоединённой мощности выход на оптовый рынок невозможен"},
	{"00-reference/02-product-scope-and-limits.md", "Выход на оптовый рынок",
		"От 750 кВт, но менее 20 МВт участие возможно через энергосбытовую компанию-посредника"},
	{"00-reference/02-product-scope-and-limits.md", "Выход на оптовый рынок",
		"От 20 МВт возможно прямое участие"},
	{"00-reference/02-product-scope-and-limits.md", "Выход на оптовый рынок",
		"В изолированных энергосистемах, указанных в материалах (Камчатка, Магадан, Сахалин, Чукотка), оптовый рынок не функционирует"},
	{"00-reference/02-product-scope-and-limits.md", "Выход на оптовый рынок",
		"Потребление от 1 млн кВт·ч в месяц"},
	{"00-reference/02-product-scope-and-limits.md", "Выход на оптовый рынок",
		"ориентир экономической целесообразности, а не формальный порог допуска"},
	{"00-reference/02-product-scope-and-limits.md", "Солнечные электростанции",
		"частные жилые дома не входят в целевой сегмент"},
	{"00-reference/02-product-scope-and-limits.md", "Солнечные электростанции",
		"Монтаж на старой шиферной кровле"},
	{"00-reference/02-product-scope-and-limits.md", "Солнечные электростанции",
		"назван экономически сомнительным"},
	{"00-reference/02-product-scope-and-limits.md", "Поиск коммерческих потерь",
		"Основной целевой клиент --- электросетевая организация"},
	{"00-reference/02-product-scope-and-limits.md", "Поиск коммерческих потерь",
		"Энергосбытовой компании продукт подходит, если у неё есть сетевая организация на балансе"},
	{"00-reference/02-product-scope-and-limits.md", "Поиск коммерческих потерь",
		"Для контроля собственного потребления промышленного предприятия предназначена платформа учёта"},
	{"00-reference/02-product-scope-and-limits.md", "Распознавание показаний по фотографии",
		"Тепло и газ могут рассматриваться как отдельная доработка, но не указаны как готовые функции"},
	{"00-reference/03-calculation-and-requests.md", "Для анализа затрат и выхода на оптовый рынок",
		"класс напряжения подключения"},
	{"00-reference/03-calculation-and-requests.md", "Бесплатная предварительная оценка",
		"помогает оценить ожидаемый эффект, окупаемость и состав работ"},
	{"00-reference/03-calculation-and-requests.md", "Обратный звонок",
		"если клиенту удобнее устно описать объект или требуется разобрать сложную схему"},
}

// Of — оценка заявки.
func Of(in Input) Score {
	p := in.Passport
	if p.Values == nil {
		p.Values = map[string]passport.Value{}
	}
	view := p.Render()
	s := Score{Product: view.Product, Reasons: []string{}, Missing: []string{}}
	val := func(key string) string { return strings.ToLower(p.Values[key].Value) }

	// Соответствие: продукт определён и паспорт не противоречит границам
	// продукта (00-reference/02-product-scope-and-limits.md).
	hasProduct := view.Product != passport.General
	b := bounds(view.Product, val)
	switch {
	case hasProduct && len(b.violations) == 0:
		s.Points += pointsFit
		s.Reasons = append(s.Reasons, "Подходит: "+view.ProductLabel)
	case hasProduct:
		for _, v := range b.violations {
			s.Reasons = append(s.Reasons, "Не подходит: "+v)
		}
	}
	s.Reasons = append(s.Reasons, b.notes...)

	// Полнота: доля заполненных полей чек-листа продукта — раздел «Какие
	// сведения могут понадобиться», 00-reference/03-calculation-and-requests.md
	// (тот же список, что в паспорте T2).
	if view.Total > 0 {
		s.Points += pointsComplete * view.Filled / view.Total
		scope := "для «" + view.ProductLabel + "»"
		if !hasProduct {
			scope = "общих сведений"
		}
		s.Reasons = append(s.Reasons, fmt.Sprintf("Заполнено %d из %d полей %s", view.Filled, view.Total, scope))
	}
	for _, key := range passport.Required[view.Product] {
		if p.Values[key].Value == "" {
			if f, ok := passport.Lookup(key); ok {
				s.Missing = append(s.Missing, lowerFirst(f.Label))
			}
		}
	}
	for _, m := range b.ask {
		if !contains(s.Missing, m) {
			s.Missing = append(s.Missing, m)
		}
	}

	// Намерение.
	client := clientText(in.Turns)
	// Расчёт, стоимость, сроки — следующий шаг по базе: «Бесплатная
	// предварительная оценка» (00-reference/03-calculation-and-requests.md)
	// помогает оценить эффект, окупаемость и состав работ.
	if hasAny(client, askedPrice) {
		s.Points += pointsIntent
		s.Reasons = append(s.Reasons, "Спрашивал про расчёт, стоимость или сроки")
	}
	// Согласие на звонок — «Обратный звонок», там же.
	if in.Agreed || p.HandoffAgreed {
		s.Points += pointsIntent
		s.Reasons = append(s.Reasons, "Сам попросил связаться")
	}
	// Объём — первый пункт, по которому база подбирает продукт: мощность,
	// месячное потребление, количество приборов («Для первичного понимания
	// задачи», «Для платформы учёта», там же).
	for _, key := range []string{"connected_power", "monthly_consumption", "meters"} {
		if v := p.Values[key].Value; v != "" {
			f, _ := passport.Lookup(key)
			s.Points += pointsIntent
			s.Reasons = append(s.Reasons, "Назвал объём: "+lowerFirst(f.Label)+" — "+v)
			break
		}
	}

	// Минусы.
	if hasAny(client, casual) {
		s.Points -= penaltyCasual
		s.Reasons = append(s.Reasons, "Минус: клиент сказал, что просто интересуется")
	}
	if !hasProduct && p.Values["task"].Value == "" {
		s.Points -= penaltyOffTask
		s.Reasons = append(s.Reasons, "Минус: продукт и задача не определены — вопрос вне продуктов базы или задача не названа")
	}

	s.Points = max(0, min(100, s.Points))
	switch {
	case s.Points >= hotFrom && len(b.violations) == 0:
		s.Grade = Hot
	case s.Points >= warmFrom:
		s.Grade = Warm
	default:
		s.Grade = Cold
	}
	return s
}

// boundsResult — что паспорт говорит о границах продукта.
type boundsResult struct {
	// violations — паспорт противоречит границам: продукт не подходит.
	violations []string
	// notes — что из границ уже ясно (без влияния на баллы).
	notes []string
	// ask — что уточнить, чтобы проверить границы.
	ask []string
}

// bounds — границы продукта из 00-reference/02-product-scope-and-limits.md.
func bounds(product passport.Group, val func(string) string) boundsResult {
	var r boundsResult
	switch product {
	case passport.Wholesale:
		// «Выход на оптовый рынок»: порог по присоединённой мощности.
		if kw, ok := PowerKW(val("connected_power")); ok {
			switch {
			case kw < wholesaleMinKW:
				r.violations = append(r.violations, "присоединённая мощность ниже 750 кВт — выход на оптовый рынок невозможен")
			case kw < wholesaleDirectKW:
				r.notes = append(r.notes, "Мощность от 750 кВт и менее 20 МВт — участие через энергосбытовую компанию-посредника")
			default:
				r.notes = append(r.notes, "Мощность от 20 МВт — возможно прямое участие в оптовом рынке")
			}
		}
		// Там же: изолированные энергосистемы.
		region := val("region")
		for _, ir := range isolatedRegions {
			if strings.Contains(region, ir.Stem) {
				r.violations = append(r.violations, "регион в изолированной энергосистеме ("+ir.Name+") — оптовый рынок там не функционирует")
			}
		}
		if region == "" {
			r.ask = append(r.ask, "регион")
		}
		// Там же: ориентир целесообразности — не порог допуска, на оценку
		// не влияет.
		if kwh, ok := MonthlyKWh(val("monthly_consumption")); ok {
			if kwh >= wholesaleWorthKWh {
				r.notes = append(r.notes, "Потребление от 1 млн кВт·ч в месяц — ориентир экономической целесообразности")
			} else {
				r.notes = append(r.notes, "Потребление ниже ориентира 1 млн кВт·ч в месяц — целесообразность покажет расчёт (это не порог допуска)")
			}
		}
	case passport.Solar:
		// «Солнечные электростанции»: частные жилые дома не в сегменте.
		for _, key := range []string{"org_type", "object_type"} {
			if v := val(key); strings.Contains(v, "частн") && strings.Contains(v, "дом") {
				r.violations = append(r.violations, "частные жилые дома не входят в целевой сегмент солнечных станций")
				break
			}
		}
		// Там же: старая шиферная кровля.
		if strings.Contains(val("site_area"), "шифер") {
			r.notes = append(r.notes, "Шиферная кровля: монтаж на старой шиферной кровле в материалах назван экономически сомнительным")
			r.ask = append(r.ask, "возраст шиферной кровли")
		}
	case passport.Losses:
		// «Поиск коммерческих потерь»: основной клиент — сетевая
		// организация; сбыту — если на балансе есть сеть; собственное
		// потребление предприятия — платформа учёта.
		org := val("org_type")
		switch {
		case org == "":
			r.ask = append(r.ask, "тип организации: сетевая или энергосбытовая")
		case strings.Contains(org, "сбыт"):
			r.ask = append(r.ask, "есть ли на балансе сетевая организация")
		case !strings.Contains(org, "сет") && hasAny(org, industrial):
			r.violations = append(r.violations, "для контроля собственного потребления предприятия предназначена платформа учёта, а не поиск потерь")
		}
	case passport.Recognition:
		// «Распознавание показаний по фотографии»: тепло и газ — доработка.
		if v := val("resource_type"); strings.Contains(v, "тепл") || strings.Contains(v, "газ") {
			r.notes = append(r.notes, "Тепло и газ — отдельная доработка, а не готовая функция")
		}
	}
	return r
}

var (
	// askedPrice — клиент спрашивал про расчёт, стоимость или сроки.
	askedPrice = []string{"расчет", "рассчит", "посчит", "стоимост", "сколько стоит", "цена", "цену", "окуп",
		"срок", "коммерческое предложение"}
	// casual — «просто интересуюсь» (ROADMAP T3, «Минусы»).
	casual = []string{"просто интересуюсь", "просто интересно", "просто спрашиваю", "из любопытства", "пока просто смотрю"}
	// industrial — промышленное предприятие (основы слов).
	industrial = []string{"завод", "фабрик", "производств", "промышлен", "цех"}
)

// clientText — реплики клиента одной строкой, в нижнем регистре, «ё» как «е».
func clientText(turns []dialog.Turn) string {
	var b strings.Builder
	for _, t := range turns {
		if t.Role == dialog.RoleUser {
			b.WriteString(t.Content)
			b.WriteByte('\n')
		}
	}
	return strings.ReplaceAll(strings.ToLower(b.String()), "ё", "е")
}

func hasAny(text string, words []string) bool {
	for _, w := range words {
		if strings.Contains(text, w) {
			return true
		}
	}
	return false
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func lowerFirst(s string) string {
	r := []rune(s)
	if len(r) == 0 {
		return s
	}
	return strings.ToLower(string(r[0])) + string(r[1:])
}

// number — число как его пишут люди: «1 200», «1,2», «0.8».
const number = `(\d+(?:[ \x{00a0}]\d{3})*(?:[.,]\d+)?)`

var (
	powerRe  = regexp.MustCompile(number + `\s*(мвт|мегаватт|квт|киловатт)([·*\-]\s*ч|ч)?`)
	energyRe = regexp.MustCompile(number + `\s*(млн\.?|миллион\S*|тыс\.?|тысяч\S*)?\s*` +
		`(квт[·*\-]?\s*ч|киловатт[- ]час\S*|мвт[·*\-]?\s*ч|мегаватт[- ]час\S*|гвт[·*\-]?\s*ч)`)
)

func parseNumber(s string) (float64, bool) {
	s = strings.NewReplacer(" ", "", "\u00a0", "", ",", ".").Replace(s)
	f, err := strconv.ParseFloat(s, 64)
	return f, err == nil
}

// PowerKW — присоединённая мощность в кВт из записи клиента: «800 кВт»,
// «1,2 МВт», «2 мегаватта». Без единиц — не знаем (ок = false):
// мощность без единиц не судим.
func PowerKW(s string) (float64, bool) {
	for _, m := range powerRe.FindAllStringSubmatch(strings.ToLower(s), -1) {
		if m[3] != "" {
			continue // кВт·ч — это энергия, а не мощность
		}
		n, ok := parseNumber(m[1])
		if !ok {
			continue
		}
		if strings.HasPrefix(m[2], "м") {
			n *= 1000
		}
		return n, true
	}
	return 0, false
}

// MonthlyKWh — месячное потребление в кВт·ч: «1,2 млн кВт·ч», «800 тыс.
// кВт·ч», «500 МВт·ч». Без единиц — не знаем.
func MonthlyKWh(s string) (float64, bool) {
	m := energyRe.FindStringSubmatch(strings.ToLower(s))
	if m == nil {
		return 0, false
	}
	n, ok := parseNumber(m[1])
	if !ok {
		return 0, false
	}
	switch {
	case strings.HasPrefix(m[2], "млн"), strings.HasPrefix(m[2], "миллион"):
		n *= 1e6
	case strings.HasPrefix(m[2], "тыс"):
		n *= 1e3
	}
	switch {
	case strings.HasPrefix(m[3], "мвт"), strings.HasPrefix(m[3], "мегаватт"):
		n *= 1e3
	case strings.HasPrefix(m[3], "гвт"):
		n *= 1e6
	}
	return n, true
}
