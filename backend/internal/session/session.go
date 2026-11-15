// Package session — диалоговая сессия клиента: один разговор от первого
// вопроса до «Нового диалога».
//
// id сессии выдаёт фронт: «Новый диалог» создаёт новый id, и сервер
// видит ровно те разговоры, что и клиент. Сервер — источник истины для
// менеджера; localStorage браузера — только кэш интерфейса.
package session

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
	"github.com/Danila331/mts-ai/backend/internal/passport"
)

// Channel — откуда пришёл разговор.
type Channel string

const (
	Playground Channel = "playground"
	Embed      Channel = "embed"
	Telegram   Channel = "telegram"
)

// idPattern — id фронта: буквы, цифры, «-» и «_». Длина с запасом: фронт
// выдаёт около 16 знаков, uuid — 36.
var idPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// TitleRunes — длина заголовка сессии: первая реплика, обрезанная до
// строки в списке разговоров.
const TitleRunes = 80

// Ref — сессия, к которой относится вопрос. Нулевое значение — клиент
// сессию не прислал (старый фронт, внешний вызов): ответ всё равно
// пишется в журнал, но без сессии.
type Ref struct {
	ID      string
	Channel Channel
}

// Parse проверяет id и канал из запроса. Пустой id — нулевой Ref без
// ошибки: поля необязательны ради обратной совместимости.
func Parse(id, channel string) (Ref, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return Ref{}, nil
	}
	if !idPattern.MatchString(id) {
		return Ref{}, apperr.Invalidf("session_id: от 8 до 64 знаков, латиница, цифры, «-» и «_»")
	}
	switch c := Channel(strings.TrimSpace(channel)); c {
	case "":
		return Ref{ID: id, Channel: Playground}, nil
	case Playground, Embed, Telegram:
		return Ref{ID: id, Channel: c}, nil
	default:
		return Ref{}, apperr.Invalidf("channel: playground, embed или telegram")
	}
}

// Title — заголовок сессии из первой реплики клиента.
func Title(question string) string {
	q := strings.Join(strings.Fields(question), " ")
	if utf8.RuneCountInString(q) <= TitleRunes {
		return q
	}
	r := []rune(q)
	return strings.TrimSpace(string(r[:TitleRunes-1])) + "…"
}

// Session — разговор, как его видит менеджер.
type Session struct {
	ID        string          `json:"id"`
	Channel   string          `json:"channel"`
	Mode      string          `json:"mode"`
	Title     string          `json:"title"`
	Page      json.RawMessage `json:"page"`
	Passport  *passport.View  `json:"passport,omitempty"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// Turn — реплика разговора по порядку. Ответ консультанта знает свой id
// в журнале и разделы базы, на которые опирался.
type Turn struct {
	Role     string    `json:"role"`
	Content  string    `json:"content"`
	AnswerID string    `json:"answer_id,omitempty"`
	Sources  []string  `json:"sources,omitempty"`
	Fallback bool      `json:"fallback,omitempty"`
	At       time.Time `json:"at"`
}

// History — сессия и все её реплики.
type History struct {
	Session Session `json:"session"`
	Turns   []Turn  `json:"turns"`
}

// ErrNotFound — сессии с таким id нет: не было или удалена по сроку.
var ErrNotFound = errors.New("сессия не найдена")
