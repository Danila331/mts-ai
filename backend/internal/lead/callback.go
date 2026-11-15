package lead

import (
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
// часовой пояс Europe/Moscow». Пусто — клиент не выбрал часть дня.
func (c Callback) Label() string {
	label := c.TimeLabel()
	if label == "" {
		return ""
	}
	if c.Timezone != "" {
		label += ", часовой пояс " + c.Timezone
	}
	return label
}
