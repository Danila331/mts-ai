package lead

import (
	"strings"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
	"github.com/Danila331/mts-ai/backend/internal/passport"
)

// Kind — тип заявки (T17): не только «перезвоните», а честные точки
// входа, каждая из которых описана в базе знаний.
type Kind string

const (
	// KindCallback — обратный звонок: «Обратный звонок»,
	// 00-reference/03-calculation-and-requests.md. Для всех продуктов.
	KindCallback Kind = "callback"
	// KindAssessment — бесплатная предварительная оценка: «Бесплатная
	// предварительная оценка», там же. Для всех продуктов.
	KindAssessment Kind = "assessment"
	// KindDemo — демо-кабинет: «Как посмотреть до покупки»,
	// 20-products/22-askue.md. Только платформа учёта.
	KindDemo Kind = "demo"
	// KindPilot — пилотное подключение «один прибор из пяти»: там же.
	// Только платформа учёта.
	KindPilot Kind = "pilot"
)

// KindInfo — тип заявки, его подпись и основание в базе.
type KindInfo struct {
	Kind  Kind
	Label string
	// Products — для каких продуктов тип годится; nil — для всех.
	Products []passport.Group
	// Doc, Section, Quote — основание в базе: тест сверяет цитату с
	// текстом раздела.
	Doc, Section, Quote string
}

// Kinds — все типы заявки в порядке показа. Формулировки — по базе.
var Kinds = []KindInfo{
	{KindCallback, "Обратный звонок", nil,
		"00-reference/03-calculation-and-requests.md", "Обратный звонок",
		"Обратный звонок --- существующий способ продолжить общение с МТС"},
	{KindAssessment, "Бесплатная предварительная оценка", nil,
		"00-reference/03-calculation-and-requests.md", "Бесплатная предварительная оценка",
		"Для продуктов EnergyTool доступна бесплатная предварительная оценка"},
	{KindDemo, "Демо-кабинет платформы учёта", []passport.Group{passport.Platform},
		"20-products/22-askue.md", "Как посмотреть до покупки",
		"Демо-кабинет предоставляется по запросу"},
	{KindPilot, "Пилотное подключение: один прибор из пяти", []passport.Group{passport.Platform},
		"20-products/22-askue.md", "Как посмотреть до покупки",
		"клиент переводит на платформу один прибор из пяти"},
}

// ParseKind — тип заявки из запроса; пусто — обратный звонок (так
// работала заявка до типов). Неизвестный тип — отказ.
func ParseKind(s string) (Kind, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return KindCallback, nil
	}
	for _, k := range Kinds {
		if string(k.Kind) == s {
			return k.Kind, nil
		}
	}
	return "", apperr.Invalidf("Тип заявки: обратный звонок, предварительная оценка, демо-кабинет или пилотное подключение")
}

// Label — подпись типа; пусто — неизвестный тип.
func (k Kind) Label() string {
	for _, info := range Kinds {
		if info.Kind == k {
			return info.Label
		}
	}
	return ""
}

// KindsFor — типы заявки, которые годятся для продуктов из паспорта:
// демо-кабинет и пилот — только если среди обсуждавшихся продуктов есть
// платформа учёта.
func KindsFor(candidates []passport.Candidate) []Kind {
	out := make([]Kind, 0, len(Kinds))
	for _, info := range Kinds {
		if info.Products == nil || discussed(candidates, info.Products) {
			out = append(out, info.Kind)
		}
	}
	return out
}

// Allowed — тип годится для продуктов из паспорта.
func (k Kind) Allowed(candidates []passport.Candidate) bool {
	for _, ok := range KindsFor(candidates) {
		if ok == k {
			return true
		}
	}
	return false
}

func discussed(candidates []passport.Candidate, products []passport.Group) bool {
	for _, c := range candidates {
		for _, p := range products {
			if c.Product == p {
				return true
			}
		}
	}
	return false
}
