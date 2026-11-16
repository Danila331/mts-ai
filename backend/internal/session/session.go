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
	"fmt"
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
	// Page — страница сайта, с которой открыт виджет (ParsePage): только
	// для аналитики разговоров. Ядру и в промпт не уходит. Пусто — фронт
	// страницу не прислал, у сессии остаётся прежняя.
	Page json.RawMessage
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

// Страница виджета — что загрузчик виджета (web/widget/loader.ts) знает о
// странице сайта: путь, заголовок и UTM-метки. Только эти поля: без
// cookies, полного адреса с другими параметрами и referrer.
const (
	// PageBytes — предел объекта page в теле запроса.
	PageBytes = 2 << 10
	// PageValueRunes — предел каждого значения.
	PageValueRunes = 300
)

// pageKeys — разрешённые ключи page.
var pageKeys = map[string]bool{
	"path": true, "title": true,
	"utm_source": true, "utm_medium": true, "utm_campaign": true, "utm_term": true, "utm_content": true,
}

// ParsePage строго проверяет страницу из запроса и отдаёт её компактным
// JSON без пустых значений. Пусто, null и {} — nil без ошибки: поле
// необязательно. Всё, что не объект из разрешённых ключей со строками
// до PageValueRunes знаков, — ошибка формата.
func ParsePage(raw json.RawMessage) (json.RawMessage, error) {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	if len(raw) > PageBytes {
		return nil, apperr.Invalidf(fmt.Sprintf("page: не больше %d байт", PageBytes))
	}
	var fields map[string]any
	if raw[0] != '{' || json.Unmarshal(raw, &fields) != nil {
		return nil, apperr.Invalidf("page: ожидается объект {path, title, utm_*}")
	}
	page := make(map[string]string, len(fields))
	for k, v := range fields {
		if !pageKeys[k] {
			return nil, apperr.Invalidf(fmt.Sprintf("page: неизвестное поле «%s» — только path, title и utm_source|medium|campaign|term|content", k))
		}
		s, ok := v.(string)
		if !ok {
			return nil, apperr.Invalidf(fmt.Sprintf("page.%s: ожидается строка", k))
		}
		if utf8.RuneCountInString(s) > PageValueRunes {
			return nil, apperr.Invalidf(fmt.Sprintf("page.%s: не длиннее %d знаков", k, PageValueRunes))
		}
		if s = strings.TrimSpace(s); s != "" {
			page[k] = s
		}
	}
	if len(page) == 0 {
		return nil, nil
	}
	out, err := json.Marshal(page)
	if err != nil {
		return nil, apperr.Invalidf("page: ожидается объект {path, title, utm_*}")
	}
	return out, nil
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
	ID       string          `json:"id"`
	Channel  string          `json:"channel"`
	Mode     string          `json:"mode"`
	Title    string          `json:"title"`
	Page     json.RawMessage `json:"page"`
	Passport *passport.View  `json:"passport,omitempty"`
	// Role и RoleSource — роль-подсказка собеседника (T15); пусто — роль
	// неизвестна. Level — уровень объяснения (T16).
	Role       string    `json:"role"`
	RoleSource string    `json:"role_source"`
	Level      string    `json:"level"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
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

// History — сессия и все её реплики. LeadCode и LeadKind — заявка, которую
// клиент оставил из этого разговора; пусто — разговор без заявки.
type History struct {
	Session  Session `json:"session"`
	Turns    []Turn  `json:"turns"`
	LeadCode string  `json:"lead_code,omitempty"`
	LeadKind string  `json:"lead_kind,omitempty"`
}

// ListItem — строка списка диалогов менеджера. Product — продукт, который
// обсуждали первым (по паспорту); пусто — пока не ясно.
type ListItem struct {
	ID           string         `json:"id"`
	Channel      string         `json:"channel"`
	Title        string         `json:"title"`
	Role         string         `json:"role"`
	Product      passport.Group `json:"product"`
	ProductLabel string         `json:"product_label"`
	Messages     int            `json:"messages"`
	HasLead      bool           `json:"has_lead"`
	LeadCode     string         `json:"lead_code,omitempty"`
	LeadKind     string         `json:"lead_kind,omitempty"`
	CreatedAt    time.Time      `json:"created_at"`
	UpdatedAt    time.Time      `json:"updated_at"`
}

// ListPage — страница списка диалогов и их общее число.
type ListPage struct {
	Items []ListItem `json:"items"`
	Total int        `json:"total"`
}

// ErrNotFound — сессии с таким id нет: не было или удалена по сроку.
var ErrNotFound = errors.New("сессия не найдена")
