// Package privacy — персональные данные: сколько их хранить и как
// удалить по запросу человека (152-ФЗ, ст. 5, 14, 21).
//
// Персональные данные здесь — имя, телефон и компания в заявке, а также
// всё, что человек сам написал в чат: вопросы ложатся в журнал ответов,
// в оценки и в диалог заявки. Поэтому срок хранения есть у всех трёх
// таблиц, а удаление по номеру ищет его и в тексте.
package privacy

import (
	"time"
	"unicode"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
)

// Policy — сколько хранить записи. Ноль — без срока (только для
// разработки: в бою Verify конфигурации его не пропускает).
type Policy struct {
	Leads    time.Duration
	Answers  time.Duration
	Feedback time.Duration
}

// Cutoffs — граница: всё, что создано раньше, удаляется. Нулевое время —
// таблица не чистится.
type Cutoffs struct {
	Leads    time.Time
	Answers  time.Time
	Feedback time.Time
}

// Cutoffs переводит срок в границы на момент now.
func (p Policy) Cutoffs(now time.Time) Cutoffs {
	at := func(d time.Duration) time.Time {
		if d <= 0 {
			return time.Time{}
		}
		return now.Add(-d)
	}
	return Cutoffs{Leads: at(p.Leads), Answers: at(p.Answers), Feedback: at(p.Feedback)}
}

// Counts — сколько строк удалено по таблицам.
type Counts struct {
	Leads    int64
	Answers  int64
	Feedback int64
	// Sessions — разговоры: заголовок сессии — первая реплика клиента.
	Sessions int64
}

// Total — всего строк.
func (c Counts) Total() int64 { return c.Leads + c.Answers + c.Feedback + c.Sessions }

// Subject — чьи данные удалить: по номеру телефона, по номеру заявки или
// по обоим.
type Subject struct {
	// Phone10 — последние десять цифр телефона.
	Phone10 string
	// LeadCode — номер заявки, который видел клиент.
	LeadCode string
}

// NewSubject проверяет запрос на удаление.
//
// Телефон — не короче десяти цифр: по более короткому совпадению в тексте
// удалилось бы чужое. Сравнение по последним десяти цифрам делает
// «8 900 …» и «+7 (900) …» одним номером.
func NewSubject(phone, leadCode string) (Subject, error) {
	var digits []rune
	for _, r := range phone {
		if unicode.IsDigit(r) {
			digits = append(digits, r)
		}
	}
	s := Subject{LeadCode: leadCode}
	if phone != "" {
		if len(digits) < 10 {
			return Subject{}, apperr.Invalidf("телефон: нужно не меньше десяти цифр")
		}
		s.Phone10 = string(digits[len(digits)-10:])
	}
	if s.Phone10 == "" && s.LeadCode == "" {
		return Subject{}, apperr.Invalidf("укажите телефон или номер заявки")
	}
	return s, nil
}
