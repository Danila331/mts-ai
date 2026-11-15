package lead

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
)

// Callback — когда клиенту удобнее, чтобы ему позвонили (T4).
//
// Это предпочтение, а не запись на время: база запрещает обещать точное
// время звонка, имя специалиста и содержание разговора (раздел «Обратный
// звонок», knowledge-base/00-reference/03-calculation-and-requests.md).
// Поэтому здесь только часть дня и часовой пояс клиента — менеджер учтёт
// их, но ничего не обещает.
type Callback struct {
	// Time — часть дня: morning | day | evening | any; пусто — не выбрал.
	Time string `json:"time,omitempty"`
	// Timezone — часовой пояс IANA из браузера клиента («Europe/Moscow»).
	Timezone string `json:"timezone,omitempty"`
}

// CallbackTimes — варианты части дня с подписями, в порядке показа.
var CallbackTimes = []struct{ Value, Label string }{
	{"morning", "утро"},
	{"day", "день"},
	{"evening", "вечер"},
	{"any", "любое время"},
}

// RUTimezones — пояса России с городом и сдвигом от UTC для подписи менеджеру
// («Москва (UTC+3)»). Тот же список, что RU_TIMEZONES в web/src/lib/callback.ts;
// соответствие проверяют тесты с обеих сторон.
var RUTimezones = []struct {
	Zone, City string
	UTC        int
}{
	{"Europe/Kaliningrad", "Калининград", 2},
	{"Europe/Moscow", "Москва", 3},
	{"Europe/Samara", "Самара", 4},
	{"Asia/Yekaterinburg", "Екатеринбург", 5},
	{"Asia/Omsk", "Омск", 6},
	{"Asia/Krasnoyarsk", "Красноярск", 7},
	{"Asia/Irkutsk", "Иркутск", 8},
	{"Asia/Yakutsk", "Якутск", 9},
	{"Asia/Vladivostok", "Владивосток", 10},
	{"Asia/Magadan", "Магадан", 11},
	{"Asia/Kamchatka", "Камчатка", 12},
}

// TimezoneLabel — человекочитаемая подпись пояса: «Москва (UTC+3)». Пояс вне
// списка России остаётся именем IANA с пробелами вместо «_».
func TimezoneLabel(zone string) string {
	for _, z := range RUTimezones {
		if z.Zone == zone {
			return fmt.Sprintf("%s (UTC+%d)", z.City, z.UTC)
		}
	}
	return strings.ReplaceAll(zone, "_", " ")
}

// tzName — имя часового пояса IANA: «Europe/Moscow», «Asia/Yekaterinburg»,
// «America/Argentina/Buenos_Aires», «UTC».
var tzName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_+\-]*(?:/[A-Za-z0-9_+\-]+){0,2}$`)

// maxTimezone — длина имени пояса с запасом.
const maxTimezone = 64

// Normalize проверяет часть дня и чистит часовой пояс. Неизвестная часть
// дня — отказ: её выбирают кнопкой, и чужое значение — ошибка клиента
// API. Непонятный пояс просто отбрасывается: его прислал браузер, и
// клиенту его не исправить, а заявка важнее.
func (c Callback) Normalize() (Callback, error) {
	c.Time = strings.TrimSpace(c.Time)
	c.Timezone = strings.TrimSpace(c.Timezone)
	if c.Time != "" && c.TimeLabel() == "" {
		return Callback{}, apperr.Invalidf("Удобное время: утро, день, вечер или любое")
	}
	if len(c.Timezone) > maxTimezone || !tzName.MatchString(c.Timezone) {
		c.Timezone = ""
	}
	return c, nil
}

// TimeLabel — подпись части дня; пусто — не выбрана или неизвестна.
func (c Callback) TimeLabel() string {
	for _, t := range CallbackTimes {
		if t.Value == c.Time {
			return t.Label
		}
	}
	return ""
}

// Empty — клиент ничего не выбрал.
func (c Callback) Empty() bool { return c.Time == "" }

// Label — предпочтение одной строкой для паспорта и резюме: «утро,
// Москва (UTC+3)». Пусто — клиент не выбрал часть дня.
func (c Callback) Label() string {
	label := c.TimeLabel()
	if label == "" {
		return ""
	}
	if c.Timezone != "" {
		label += ", " + TimezoneLabel(c.Timezone)
	}
	return label
}
