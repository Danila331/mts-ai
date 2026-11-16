// Package analytics — простая аналитика экрана менеджера (T6): воронка
// «сессии → ответы → паспорт → заявки», заявки по оценке, типу и каналу,
// «пробелы базы» — вопросы, на которые бот дал запасной ответ.
//
// Считается двумя агрегатными запросами к базе (queries/analytics.sql); здесь
// — форма отчёта и сборка из сырых счётчиков, чтобы её можно было проверить
// без базы.
package analytics

import (
	"encoding/json"
	"time"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/lead/score"
)

// Периоды отчёта, дней.
var Periods = []int{7, 30}

// ParseDays — период из запроса; пусто — неделя.
func ParseDays(n int, given bool) (int, error) {
	if !given {
		return Periods[0], nil
	}
	for _, p := range Periods {
		if p == n {
			return n, nil
		}
	}
	return 0, apperr.Invalidf("days: 7 или 30")
}

const (
	// MinPassportFields — сколько полей паспорта должно быть заполнено,
	// чтобы сессия считалась «паспорт заполнен». Контакты клиента не в
	// счёт: их даёт заявка, а не разговор.
	MinPassportFields = 3
	// GapsLimit — сколько вопросов-пробелов в отчёте.
	GapsLimit = 20
)

// ContactKeys — поля паспорта, которые не считаются «заполненным паспортом»
// (internal/passport, группа Contacts).
var ContactKeys = []string{"name", "phone", "company", "callback_preference"}

// Raw — сырые счётчики из запроса AnalyticsSummary.
type Raw struct {
	Sessions, Answered, Filled, WithLead, Leads, Answers, Fallbacks int
	ByGrade, ByKind, SessionsByChannel, LeadsByChannel              map[string]int
}

// DecodeCounts — объект {ключ: число} из jsonb; битый — пустой.
func DecodeCounts(raw []byte) map[string]int {
	m := map[string]int{}
	_ = json.Unmarshal(raw, &m)
	return m
}

// Stage — шаг воронки.
type Stage struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Count int    `json:"count"`
	// Share — доля от первого шага, 0..1.
	Share float64 `json:"share"`
}

// Bucket — строка среза.
type Bucket struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

// Channel — канал: сессии и заявки из них.
type Channel struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Sessions int    `json:"sessions"`
	Leads    int    `json:"leads"`
}

// Gap — вопрос, на который бот дал запасной ответ. Текст без телефонов и
// почты.
type Gap struct {
	Question string    `json:"question"`
	Count    int       `json:"count"`
	LastAt   time.Time `json:"last_at"`
}

// Report — отчёт за период.
type Report struct {
	Days      int       `json:"days"`
	MinFields int       `json:"min_fields"`
	Funnel    []Stage   `json:"funnel"`
	Leads     int       `json:"leads"`
	ByGrade   []Bucket  `json:"by_grade"`
	ByKind    []Bucket  `json:"by_kind"`
	ByChannel []Channel `json:"by_channel"`
	Answers   int       `json:"answers"`
	Fallbacks int       `json:"fallbacks"`
	// GapSignal — по какому признаку ищутся пробелы. Уверенность ответа в
	// журнале не хранится, поэтому признак один — запасной ответ.
	GapSignal string `json:"gap_signal"`
	Gaps      []Gap  `json:"gaps"`
}

var channels = []struct{ Key, Label string }{
	{"playground", "Стенд"}, {"embed", "Виджет"}, {"telegram", "Telegram"}, {"unknown", "Без сессии"},
}

// Build собирает отчёт из счётчиков и списка пробелов.
func Build(days int, raw Raw, gaps []Gap) Report {
	r := Report{Days: days, MinFields: MinPassportFields, Leads: raw.Leads, Answers: raw.Answers, Fallbacks: raw.Fallbacks,
		GapSignal: "fallback", Gaps: gaps}
	if r.Gaps == nil {
		r.Gaps = []Gap{}
	}
	for _, s := range []struct {
		key, label string
		n          int
	}{
		{"sessions", "Сессии", raw.Sessions},
		{"answered", "Есть ответ бота", raw.Answered},
		{"passport", "Паспорт заполнен", raw.Filled},
		{"leads", "Заявка", raw.WithLead},
	} {
		st := Stage{Key: s.key, Label: s.label, Count: s.n}
		if raw.Sessions > 0 {
			st.Share = float64(s.n) / float64(raw.Sessions)
		}
		r.Funnel = append(r.Funnel, st)
	}
	for _, g := range []score.Grade{score.Hot, score.Warm, score.Cold} {
		r.ByGrade = append(r.ByGrade, Bucket{string(g), lead.GradeLabel(g), raw.ByGrade[string(g)]})
	}
	r.ByGrade = append(r.ByGrade, Bucket{"unscored", "Без оценки", raw.ByGrade["unscored"]})
	for _, k := range lead.Kinds {
		r.ByKind = append(r.ByKind, Bucket{string(k.Kind), k.Label, raw.ByKind[string(k.Kind)]})
	}
	for _, c := range channels {
		r.ByChannel = append(r.ByChannel, Channel{c.Key, c.Label, raw.SessionsByChannel[c.Key], raw.LeadsByChannel[c.Key]})
	}
	return r
}
