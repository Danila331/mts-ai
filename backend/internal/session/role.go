package session

import (
	"regexp"
	"strings"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
)

// Role — роль-подсказка (T15): кто, вероятно, пишет в чат. Роль — не
// шлагбаум: чат отвечает и без неё. Она меняет приветствие и быстрые
// вопросы на фронте и добавляет в промпт режима chat одну строку о
// собеседнике (energybot/prompts.py, ROLE_HINT). Новых фактов роль не
// приносит: ответ по-прежнему только по базе знаний.
//
// Пять аудиторий кейса — кнопки на пустом экране; остальные — сегменты
// базы из раздела «Навигация по типу компании»
// (knowledge-base/20-products/20-portfolio.md), они за кнопкой «Другое».
// Тот же список — в web/src/lib/roles.ts и energybot/prompts.py (ROLES).
type Role string

const (
	RoleBusiness   Role = "business"    // малый и средний бизнес
	RoleEngineer   Role = "engineer"    // энергетик, главный инженер
	RoleHousing    Role = "housing"     // СНТ, УК, ТСЖ, товарищество
	RoleGrid       Role = "grid"        // электросетевая компания
	RoleMTSManager Role = "mts_manager" // региональный менеджер МТС
	// Сегменты базы («Навигация по типу компании»).
	RoleIndustry  Role = "industry"  // промышленное предприятие
	RoleSupplier  Role = "supplier"  // энергосбытовая компания
	RoleUtility   Role = "utility"   // ресурсоснабжающая организация
	RoleLandlord  Role = "landlord"  // торговый или бизнес-центр, арендодатель
	RoleRetail    Role = "retail"    // ретейл, общепит, сетевой бизнес
	RoleWarehouse Role = "warehouse" // склад, складской комплекс
)

// Roles — все роли: сначала пять аудиторий кейса, потом сегменты базы.
var Roles = []Role{
	RoleBusiness, RoleEngineer, RoleHousing, RoleGrid, RoleMTSManager,
	RoleIndustry, RoleSupplier, RoleUtility, RoleLandlord, RoleRetail, RoleWarehouse,
}

// Known — роль из списка.
func (r Role) Known() bool {
	for _, k := range Roles {
		if r == k {
			return true
		}
	}
	return false
}

// RoleSource — откуда роль.
type RoleSource string

const (
	// RoleByClient — клиент выбрал роль кнопкой. Пустая роль от клиента —
	// он сам снял подсказку: автоопределение её не вернёт.
	RoleByClient RoleSource = "client"
	// RoleAuto — определена по репликам клиента или по типу организации из
	// паспорта (DetectRole, RoleFromOrgType).
	RoleAuto RoleSource = "auto"
)

// RoleHint — роль вопроса. Нулевое значение — роль неизвестна: ни клиент,
// ни автоопределение её не дали.
type RoleHint struct {
	Role   Role
	Source RoleSource
}

// Known — роль есть (не пусто).
func (h RoleHint) Known() bool { return h.Role != "" }

// rolesList — текст ошибки: допустимые значения по порядку.
func rolesList() string {
	names := make([]string, len(Roles))
	for i, r := range Roles {
		names[i] = string(r)
	}
	return strings.Join(names, ", ")
}

// ParseRole проверяет роль и её источник из запроса. Оба поля
// необязательны: пусто — роль неизвестна, служба попробует определить её
// сама. Роль без источника — выбор клиента: так её пришлёт любой внешний
// вызов, которому незачем знать об автоопределении.
func ParseRole(role, source string) (RoleHint, error) {
	r := Role(strings.TrimSpace(role))
	src := RoleSource(strings.TrimSpace(source))
	switch src {
	case "", RoleByClient, RoleAuto:
	default:
		return RoleHint{}, apperr.Invalidf("role_source: client или auto")
	}
	if r != "" && !r.Known() {
		return RoleHint{}, apperr.Invalidf("role: одна из " + rolesList())
	}
	switch {
	case r == "" && src == RoleByClient:
		// Клиент снял подсказку — это тоже его выбор.
		return RoleHint{Source: RoleByClient}, nil
	case r == "":
		return RoleHint{}, nil
	case src == "":
		return RoleHint{Role: r, Source: RoleByClient}, nil
	}
	return RoleHint{Role: r, Source: src}, nil
}

// Автоопределение роли — детерминированный словарь, без модели: одна и та
// же реплика всегда даёт одну и ту же роль, и это проверяется тестом. Тот
// же словарь и те же тестовые фразы — в web/src/lib/roles.ts: фронт
// показывает метку «Похоже, вы — …» сразу, не дожидаясь ответа.
//
// Текст сводится к словам: нижний регистр, «ё» → «е», всё, кроме букв и
// цифр, — пробел. Правило — цепочка слов подряд, каждое слово — шаблон
// целого слова (регулярное выражение без ^ и $). Правило «о себе»
// (self) срабатывает в репликах, только если за четыре слова до него
// клиент говорит о себе («мы», «я», «являемся», «представляю»,
// «работаю»): «мы сетевая компания» — роль, «сетевая компания отключила
// нам свет» — нет. В типе организации из паспорта (RoleFromOrgType)
// клиент уже говорит о себе, и правила «о себе» действуют без этого
// условия.

type roleRule struct {
	words []*regexp.Regexp
	self  bool
}

// roleRules — правила по ролям в порядке приоритета: сначала люди
// (менеджер МТС, энергетик), потом организации — от узких к общим.
var roleRules = func() []struct {
	role  Role
	rules []roleRule
} {
	type spec struct {
		role  Role
		plain []string
		self  []string
	}
	specs := []spec{
		{role: RoleMTSManager,
			plain: []string{`мо(й|его|ему|им|их|ими) клиент.*`, `я из мтс`, `работаю в мтс`},
			self:  []string{`менеджер.* мтс`, `сотрудник.* мтс`}},
		{role: RoleEngineer,
			plain: []string{`главн.* (энергетик.*|инженер.*)`, `инженер.* энергетик.*`},
			self:  []string{`энергетик(ом|ами)?`, `инженер(ом)?`}},
		{role: RoleGrid,
			self: []string{`электросетев.*`, `сетев.* (компани.*|организаци.*|предприяти.*)`, `тсо`, `рэс`, `пэс`}},
		{role: RoleSupplier,
			self: []string{`энергосбыт.*`, `сбытов.* (компани.*|организаци.*)`, `гарантирующ.* поставщик.*`}},
		{role: RoleUtility,
			self: []string{`ресурсоснабжающ.*`, `рсо`, `водоканал.*`, `теплосет.*`}},
		{role: RoleHousing,
			plain: []string{`снт`, `тсж`, `тсн`, `жск`, `днт`, `садовод.*`, `(садов|дачн).* (товариществ.*|некоммерческ.*|поселк.*)`,
				`коттеджн.* поселк.*`, `товариществ.*`, `управляющ.* компани.*`, `ук`, `мкд`, `многоквартирн.*`, `председател.*`,
				`жилищн.* кооператив.*`}},
		{role: RoleLandlord,
			plain: []string{`торгов.* центр.*`, `торгов.* развлекательн.* центр.*`, `тц`, `трц`, `бизнес центр.*`, `бц`,
				`арендодател.*`, `арендатор.*`}},
		{role: RoleRetail,
			plain: []string{`ретейл.*`, `ритейл.*`, `общепит.*`, `сет(ь|и|ью) (магазин.*|кафе|ресторан.*|аптек.*|кофеен|пекарен)`,
				`сетев(ой|ого|ому|ым) бизнес.*`, `магазин.*`, `супермаркет.*`, `ресторан.*`, `кафе`, `кофейн.*`, `пекарн.*`}},
		{role: RoleWarehouse,
			plain: []string{`склад(а|е|у|ом|ы|ов|ам|ами|ах)?`, `складск.*`, `(логистическ|распределительн).* (комплекс.*|центр.*)`}},
		{role: RoleIndustry,
			plain: []string{`завод.*`, `фабрик.*`, `комбинат.*`, `цех(а|е|у|ом|и|ов|ам|ами|ах)?`, `промышленн.* предприяти.*`,
				`производственн.* (компани.*|предприяти.*|площадк.*)`}},
		{role: RoleBusiness,
			plain: []string{`мсб`, `(мал|средн).* бизнес.*`, `ип`, `индивидуальн.* предпринимател.*`, `предпринимател.*`, `ооо`,
				`(наш|мой|моего|нашего|нашему|моему|нашем|моем) бизнес.*`, `небольш.* (компани.*|фирм.*|бизнес.*|предприяти.*)`}},
	}
	compile := func(pattern string, self bool) roleRule {
		var words []*regexp.Regexp
		for _, w := range strings.Fields(pattern) {
			words = append(words, regexp.MustCompile(`^(?:`+w+`)$`))
		}
		return roleRule{words: words, self: self}
	}
	out := make([]struct {
		role  Role
		rules []roleRule
	}, len(specs))
	for i, s := range specs {
		out[i].role = s.role
		for _, p := range s.plain {
			out[i].rules = append(out[i].rules, compile(p, false))
		}
		for _, p := range s.self {
			out[i].rules = append(out[i].rules, compile(p, true))
		}
	}
	return out
}()

// selfWords — клиент говорит о себе.
var selfWords = map[string]bool{
	"мы": true, "я": true, "являемся": true, "являюсь": true, "представляю": true, "работаю": true, "работаем": true,
}

// selfWindow — сколько слов до правила «о себе» смотреть на selfWords.
const selfWindow = 4

var nonWord = regexp.MustCompile(`[^a-z0-9а-я]+`)

// roleWords — текст как слова: нижний регистр, «ё» → «е», без знаков.
func roleWords(text string) []string {
	text = strings.ReplaceAll(strings.ToLower(text), "ё", "е")
	return strings.Fields(nonWord.ReplaceAllString(text, " "))
}

func (r roleRule) matchAt(words []string, i int) bool {
	if i+len(r.words) > len(words) {
		return false
	}
	for j, w := range r.words {
		if !w.MatchString(words[i+j]) {
			return false
		}
	}
	return true
}

func hasSelf(words []string, i int) bool {
	for j := max(0, i-selfWindow); j < i; j++ {
		if selfWords[words[j]] {
			return true
		}
	}
	return false
}

// detect — роль по одному тексту; aboutSelf — текст заведомо о самом
// клиенте (тип организации из паспорта).
func detect(text string, aboutSelf bool) Role {
	words := roleWords(text)
	for _, rr := range roleRules {
		for _, rule := range rr.rules {
			for i := range words {
				if rule.matchAt(words, i) && (!rule.self || aboutSelf || hasSelf(words, i)) {
					return rr.role
				}
			}
		}
	}
	return ""
}

// DetectRole — роль по репликам клиента: первая реплика, в которой клиент
// сказал о себе, решает. Реплики консультанта сюда не передаются. Пусто —
// по репликам роль не определить.
func DetectRole(clientTurns []string) Role {
	for _, t := range clientTurns {
		if r := detect(t, false); r != "" {
			return r
		}
	}
	return ""
}

// RoleFromOrgType — роль по полю «Тип организации» паспорта задачи (T2).
func RoleFromOrgType(orgType string) Role {
	return detect(orgType, true)
}
