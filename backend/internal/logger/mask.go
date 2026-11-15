package logger

import (
	"io"
	"regexp"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

// Маскировка персональных данных в журнале (T35, LLM02).
//
// Тела запросов в журнал не пишутся, но телефон, почта и имя из заявки могут
// попасть в строку косвенно: в тексте ошибки базы, модели, разбора JSON. Это
// страховка на выходе — она ловит их в готовой строке, какой бы код её ни
// написал. Телефоны и почту находит по виду; имя и компанию из заявки
// нельзя узнать по виду, поэтому обработчик заявки сообщает их через Remember.
//
// zerolog.Hook не годится: он видит событие до записи и не может изменить
// уже добавленные поля. Поэтому обёртка над io.Writer — строка JSON
// проходит через неё целиком.

const mask = "***"

var (
	emailRe = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+`)
	// Телефон: цифры с пробелами, скобками, точками и дефисами; плюс в начале.
	phoneRe = regexp.MustCompile(`\+?\d[\d \t().\-]{8,}\d`)
)

// MaskString скрывает в тексте почту, телефоны и запомненные значения.
func MaskString(s string) string {
	s = emailRe.ReplaceAllString(s, mask)
	s = maskPhones(s)
	return known.replace(s)
}

// maskPhones скрывает номера. Совпадение считается номером, если в нём 10–15
// цифр (E.164 не длиннее 15: меньше — дата, версия, длительность; больше —
// идентификатор) и оно не прилипло к буквам и цифрам: десять цифр подряд
// внутри шестнадцатеричного request_id номером не являются.
func maskPhones(s string) string {
	idx := phoneRe.FindAllStringIndex(s, -1)
	if len(idx) == 0 {
		return s
	}
	var b strings.Builder
	last := 0
	for _, loc := range idx {
		start, end := loc[0], loc[1]
		digits := 0
		for _, r := range s[start:end] {
			if unicode.IsDigit(r) {
				digits++
			}
		}
		if digits < 10 || digits > 15 || glued(s, start, end) {
			continue
		}
		b.WriteString(s[last:start])
		b.WriteString(mask)
		last = end
	}
	b.WriteString(s[last:])
	return b.String()
}

// glued — рядом с совпадением буква, цифра или «_»: это часть слова или идентификатора.
func glued(s string, start, end int) bool {
	isWord := func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' }
	if start > 0 {
		if r, _ := utf8.DecodeLastRuneInString(s[:start]); isWord(r) {
			return true
		}
	}
	if end < len(s) {
		if r, _ := utf8.DecodeRuneInString(s[end:]); isWord(r) {
			return true
		}
	}
	return false
}

// remembered — значения из заявок, которые надо скрывать в журнале: имя,
// компания, телефон. Хранятся в памяти процесса, не больше maxKnown; при
// переполнении вытесняются старые.
const (
	maxKnown = 512
	minKnown = 3
)

type registry struct {
	mu     sync.RWMutex
	values []string
}

var known registry

func (r *registry) add(v string) {
	v = strings.TrimSpace(v)
	if len([]rune(v)) < minKnown {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, have := range r.values {
		if have == v {
			return
		}
	}
	if len(r.values) >= maxKnown {
		r.values = r.values[1:]
	}
	r.values = append(r.values, v)
}

func (r *registry) replace(s string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, v := range r.values {
		if strings.Contains(s, v) {
			s = strings.ReplaceAll(s, v, mask)
		}
	}
	return s
}

// Remember сообщает журналу значения, которые нельзя выводить: имя и
// компания из заявки. Слишком короткие (меньше трёх знаков) игнорируются —
// иначе «ООО» или «Ия» стёрли бы пол-журнала.
func Remember(values ...string) {
	for _, v := range values {
		known.add(v)
	}
}

// forget нужен тестам.
func forget() {
	known.mu.Lock()
	known.values = nil
	known.mu.Unlock()
}

// maskWriter пропускает каждую запись (zerolog пишет событие одним Write)
// через MaskString.
type maskWriter struct{ w io.Writer }

// MaskWriter оборачивает вывод журнала маскировкой персональных данных.
func MaskWriter(w io.Writer) io.Writer { return maskWriter{w: w} }

func (m maskWriter) Write(p []byte) (int, error) {
	if _, err := m.w.Write([]byte(MaskString(string(p)))); err != nil {
		return 0, err
	}
	// Вызывающему важно, что принята вся запись, а не сколько байт ушло
	// после замены.
	return len(p), nil
}
