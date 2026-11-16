// Package passport — «паспорт задачи»: что клиент рассказал о себе и
// объекте, разложенное по полям для менеджера.
//
// Поля — только из чек-листов базы знаний (раздел «Какие сведения могут
// понадобиться», knowledge-base/00-reference/03-calculation-and-requests.md):
// паспорт не должен спрашивать то, чего база не называет нужным. Паспорт
// виден клиенту, и клиент может его поправить — правка клиента главнее
// того, что понял бот.
package passport

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
)

// Group — блок полей: общий, продукт или контакты.
type Group string

const (
	General     Group = "general"
	Wholesale   Group = "wholesale"
	Solar       Group = "solar"
	Platform    Group = "platform"
	Losses      Group = "losses"
	Recognition Group = "recognition"
	Contacts    Group = "contacts"
)

// Products — продукты в порядке карты продуктов базы, с подписью для клиента.
var Products = []struct {
	Group Group
	Label string
	// Doc — документ базы о продукте: по разделам этого документа в опоре
	// ответов продукт попадает в кандидаты.
	Doc string
}{
	{Wholesale, "Оптовый рынок и анализ затрат", "20-products/21-orem.md"},
	{Platform, "Платформа учёта", "20-products/22-askue.md"},
	{Solar, "Солнечная станция", "20-products/23-solar.md"},
	{Losses, "Поиск коммерческих потерь", "20-products/24-losses.md"},
	{Recognition, "Распознавание показаний", "20-products/25-meter-reading.md"},
}

// Field — одно поле паспорта.
type Field struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Group Group  `json:"group"`
	// Options — допустимые значения, если список закрытый (задача клиента).
	Options []string `json:"options,omitempty"`
}

// Tasks — задача клиента, ровно как её перечисляет база.
var Tasks = []string{"снижение платежа", "автоматизация учёта", "поиск потерь", "надёжность электроснабжения"}

// Catalog — все поля паспорта. Порядок — порядок пунктов в базе.
var Catalog = []Field{
	// «Для первичного понимания задачи»
	{Key: "org_type", Label: "Тип организации", Group: General},
	{Key: "object_type", Label: "Тип объекта", Group: General},
	{Key: "region", Label: "Регион", Group: General},
	{Key: "task", Label: "Задача", Group: General, Options: Tasks},
	{Key: "connected_power", Label: "Присоединённая мощность", Group: General},
	{Key: "monthly_consumption", Label: "Месячное потребление", Group: General},
	{Key: "metering", Label: "Приборы учёта и сбор показаний", Group: General},
	// «Для анализа затрат и выхода на оптовый рынок»
	{Key: "consumption_profile", Label: "Профиль потребления", Group: Wholesale},
	{Key: "voltage_class", Label: "Класс напряжения", Group: Wholesale},
	{Key: "supplier", Label: "Текущий поставщик", Group: Wholesale},
	{Key: "price_category", Label: "Ценовая категория", Group: Wholesale},
	{Key: "supply_points", Label: "Точки поставки и состояние учёта", Group: Wholesale},
	// «Для солнечной станции»
	{Key: "site_area", Label: "Площадь и тип кровли или площадки", Group: Solar},
	// «Для платформы учёта»
	{Key: "meters", Label: "Количество и тип приборов", Group: Platform},
	{Key: "collection_scheme", Label: "Схема сбора данных", Group: Platform},
	{Key: "metering_goal", Label: "Учёт по чему: цеха, объекты, арендаторы, абоненты", Group: Platform},
	// «Для поиска коммерческих потерь»
	{Key: "metering_data", Label: "Выгрузка данных учёта", Group: Losses},
	// «Для распознавания показаний»
	{Key: "resource_type", Label: "Тип ресурса", Group: Recognition},
	{Key: "meter_fleet", Label: "Тип и парк приборов", Group: Recognition},
	{Key: "image_channel", Label: "Способ передачи изображений", Group: Recognition},
	{Key: "photo_volume", Label: "Объём потока или архива фото", Group: Recognition},
	// Заявка
	{Key: "name", Label: "Как к вам обращаться", Group: Contacts},
	{Key: "phone", Label: "Телефон", Group: Contacts},
	{Key: "company", Label: "Компания", Group: Contacts},
	{Key: "callback_preference", Label: "Удобное время для звонка", Group: Contacts},
}

// Required — какие поля нужны для продукта: общие плюс его список из
// базы. Профиль потребления и мощность база называет и для солнца.
var Required = map[Group][]string{
	General:     {"org_type", "object_type", "region", "task", "connected_power", "monthly_consumption", "metering"},
	Wholesale:   {"connected_power", "monthly_consumption", "consumption_profile", "voltage_class", "supplier", "price_category", "supply_points"},
	Solar:       {"region", "object_type", "site_area", "connected_power", "consumption_profile", "task"},
	Platform:    {"org_type", "meters", "collection_scheme", "metering_goal"},
	Losses:      {"metering_data"},
	Recognition: {"resource_type", "meter_fleet", "image_channel", "photo_volume"},
}

var byKey = func() map[string]Field {
	m := make(map[string]Field, len(Catalog))
	for _, f := range Catalog {
		m[f.Key] = f
	}
	return m
}()

// Lookup — поле по ключу.
func Lookup(key string) (Field, bool) {
	f, ok := byKey[key]
	return f, ok
}

// Source — кто заполнил поле.
type Source string

const (
	// FromBot — понял бот из реплик клиента.
	FromBot Source = "bot"
	// FromClient — клиент заполнил или поправил сам. Бот такие поля не
	// перезаписывает.
	FromClient Source = "client"
)

// Value — значение поля.
type Value struct {
	Value  string    `json:"value"`
	Source Source    `json:"source"`
	At     time.Time `json:"at"`
}

// Candidate — продукт, который обсуждали, и разделы базы, на которые
// опирались ответы о нём.
type Candidate struct {
	Product  Group    `json:"product"`
	Sections []string `json:"sections"`
}

// Passport — хранимый паспорт сессии.
type Passport struct {
	Values     map[string]Value `json:"values"`
	Candidates []Candidate      `json:"product_candidates"`
	// HandoffAgreed — клиент согласился передать запрос менеджеру: под
	// ответом бота открывается карточка заявки.
	HandoffAgreed bool `json:"handoff_agreed,omitempty"`
}

// MaxValue — длина значения поля.
const MaxValue = 300

// Parse — паспорт из колонки jsonb; пустой или битый — пустой паспорт.
func Parse(raw []byte) Passport {
	var p Passport
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &p)
	}
	if p.Values == nil {
		p.Values = map[string]Value{}
	}
	return p
}

// Clean — значение поля для хранения: без лишних пробелов, не длиннее
// предела; телефон — в виде +7XXXXXXXXXX, задача — из списка базы.
// Пустая строка — поле не заполнено.
func Clean(key, value string) (string, error) {
	f, ok := byKey[key]
	if !ok {
		return "", apperr.Invalidf("паспорт: неизвестное поле " + key)
	}
	value = strings.Join(strings.Fields(value), " ")
	if value == "" {
		return "", nil
	}
	if utf8.RuneCountInString(value) > MaxValue {
		r := []rune(value)
		value = string(r[:MaxValue])
	}
	switch {
	case key == "phone":
		phone, ok := NormalizePhone(value)
		if !ok {
			return "", apperr.Invalidf("Телефон: нужен российский номер из 10–11 цифр, например +7 900 000-00-00")
		}
		return phone, nil
	case len(f.Options) > 0:
		for _, o := range f.Options {
			if strings.EqualFold(o, value) {
				return o, nil
			}
		}
		return "", apperr.Invalidf(f.Label + ": " + strings.Join(f.Options, ", "))
	}
	return value, nil
}

// NormalizePhone — российский номер в виде +7XXXXXXXXXX. Принимает 10
// цифр (без кода страны) и 11 цифр с ведущими 7 или 8; всё остальное —
// не номер.
func NormalizePhone(s string) (string, bool) {
	var digits []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= '0' && c <= '9':
			digits = append(digits, c)
		case c == '+' || c == ' ' || c == '-' || c == '(' || c == ')' || c == '.':
		default:
			// Неразрывный пробел и прочие не-ASCII разделители пропускаем;
			// латинская буква или другой знак — уже не номер.
			if c < 0x80 {
				return "", false
			}
		}
	}
	// «+» обещает код страны: тогда нужен полный номер +7 и десять цифр.
	plus := strings.HasPrefix(strings.TrimSpace(s), "+")
	switch {
	case len(digits) == 10 && !plus:
		return "+7" + string(digits), true
	case len(digits) == 11 && plus && digits[0] != '7':
		return "", false
	case len(digits) == 11 && (digits[0] == '7' || digits[0] == '8'):
		return "+7" + string(digits[1:]), true
	}
	return "", false
}

// Set — записать поле. Правку клиента бот не перезаписывает; пустое
// значение от клиента стирает поле.
func (p *Passport) Set(key, value string, src Source, at time.Time) {
	if p.Values == nil {
		p.Values = map[string]Value{}
	}
	if old, ok := p.Values[key]; ok && src == FromBot && old.Source == FromClient {
		return
	}
	if value == "" {
		if src == FromClient {
			delete(p.Values, key)
		}
		return
	}
	p.Values[key] = Value{Value: value, Source: src, At: at}
}

// AddSections — разделы базы из опоры ответа: документ продукта делает
// продукт кандидатом.
func (p *Passport) AddSections(refs []SectionRef) {
	for _, r := range refs {
		for _, prod := range Products {
			if r.Doc != prod.Doc {
				continue
			}
			i := p.candidate(prod.Group)
			if !contains(p.Candidates[i].Sections, r.ID) {
				p.Candidates[i].Sections = append(p.Candidates[i].Sections, r.ID)
			}
		}
	}
}

func (p *Passport) candidate(g Group) int {
	for i, c := range p.Candidates {
		if c.Product == g {
			return i
		}
	}
	p.Candidates = append(p.Candidates, Candidate{Product: g, Sections: []string{}})
	return len(p.Candidates) - 1
}

// SectionRef — раздел базы, на который опирался ответ.
type SectionRef struct {
	ID  string
	Doc string
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// HasContacts — есть всё, без чего менеджер не перезвонит.
func (p Passport) HasContacts() bool {
	for _, k := range []string{"name", "phone", "company"} {
		if p.Values[k].Value == "" {
			return false
		}
	}
	return true
}

// View — паспорт для клиента и менеджера: поля с подписями и прогресс по
// продукту, который обсуждали первым.
type View struct {
	Fields        []FieldView `json:"fields"`
	Products      []Candidate `json:"product_candidates"`
	Product       Group       `json:"product"`
	ProductLabel  string      `json:"product_label"`
	Filled        int         `json:"filled"`
	Total         int         `json:"total"`
	HandoffAgreed bool        `json:"handoff_agreed"`
	ReadyForLead  bool        `json:"ready_for_lead"`
}

// FieldView — поле с подписью и значением (пустое — не заполнено).
type FieldView struct {
	Field
	Value  string `json:"value,omitempty"`
	Source Source `json:"source,omitempty"`
}

// taskProduct — продукт, который однозначно следует из задачи клиента
// (список задач — из базы). «Снижение платежа» решают несколько продуктов,
// поэтому её здесь нет.
var taskProduct = map[string]Group{
	"автоматизация учёта":         Platform,
	"поиск потерь":                Losses,
	"надёжность электроснабжения": Solar,
}

// gridRe — электросетевая организация по словам клиента: «сетевая компания», «электросети», «ТСО», «РЭС»,
// «сбыт с сетями на балансе».
// \b в Go — только для латиницы, поэтому границы слова для «ТСО» и «РЭС» — явные.
var gridRe = regexp.MustCompile(`(?i)сетев|электросет|сет\pL* на балансе|россети|(?:^|[^\pL])(?:тсо|рэс)(?:$|[^\pL])`)

// gridOrg — тип организации пуст (ещё не назван) или сетевой.
func gridOrg(orgType string) bool {
	return strings.TrimSpace(orgType) == "" || gridRe.MatchString(orgType)
}

// primaryProduct — продукт, для которого считается прогресс паспорта: по
// задаче клиента, если она его однозначно называет, иначе — продукт с
// наибольшим числом разделов в опоре ответов (первый при равенстве). Опора
// — эвристика по совпадению слов, и одно упоминание соседнего продукта не
// должно перебивать то, о чём клиент говорит.
func (p Passport) primaryProduct() Group {
	if g, ok := taskProduct[p.Values["task"].Value]; ok {
		// Поиск коммерческих потерь — продукт электросетевой компании (база, 20-products/24-losses.md,
		// «Кому подходит»): промышленному потребителю для контроля своего потребления подходит платформа учёта,
		// сбытовой — тоже, если у неё нет сетей на балансе. Клиент, назвавший себя не сетевой организацией,
		// получает платформу; тип не назван — задача решает, как прежде.
		if g == Losses && !gridOrg(p.Values["org_type"].Value) {
			return Platform
		}
		return g
	}
	best, most := General, 0
	for _, c := range p.Candidates {
		if len(c.Sections) > most {
			best, most = c.Product, len(c.Sections)
		}
	}
	return best
}

// Render — представление паспорта.
func (p Passport) Render() View {
	v := View{Fields: make([]FieldView, 0, len(Catalog)), Products: p.Candidates, Product: General,
		ProductLabel: "общие сведения", HandoffAgreed: p.HandoffAgreed}
	if v.Products == nil {
		v.Products = []Candidate{}
	}
	v.Product = p.primaryProduct()
	for _, prod := range Products {
		if prod.Group == v.Product {
			v.ProductLabel = prod.Label
		}
	}
	for _, f := range Catalog {
		val := p.Values[f.Key]
		v.Fields = append(v.Fields, FieldView{Field: f, Value: val.Value, Source: val.Source})
	}
	for _, k := range Required[v.Product] {
		v.Total++
		if p.Values[k].Value != "" {
			v.Filled++
		}
	}
	v.ReadyForLead = p.HasContacts() || p.HandoffAgreed
	return v
}
