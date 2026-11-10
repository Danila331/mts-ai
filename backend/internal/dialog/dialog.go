// Package dialog — реплики диалога клиента с консультантом.
//
// Здесь только предмет: как из того, что прислал браузер, получить
// годный диалог, и как его пересказать. Ни HTTP, ни базы, ни ядра.
package dialog

import (
	"encoding/json"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
)

// Пределы диалога — те же, что у ядра (scripts/core_api.py). Разойдись
// они, и шлюз пропускал бы то, на что ядро отвечает отказом уже
// посреди потока.
const (
	// MaxTurns — сколько последних реплик уходит в ответ. Модели нужен
	// контекст разговора, а не вся его история.
	MaxTurns = 40
	// MaxContent — длина одной реплики в символах.
	MaxContent = 4000
)

type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

type Turn struct {
	Role    Role   `json:"role"`
	Content string `json:"content"`
}

// Mode — для чего ответ: chat разрешает боту предложить передать заявку
// менеджеру, eval отвечает строго как в сабмите.
type Mode string

const (
	ModeChat Mode = "chat"
	ModeEval Mode = "eval"
)

// ParseMode отдаёт пустой режим на всё незнакомое: тогда решает ядро
// своим умолчанием, а не шлюз своей догадкой.
func ParseMode(s string) Mode {
	switch Mode(s) {
	case ModeChat, ModeEval:
		return Mode(s)
	}
	return ""
}

var (
	errNotList  = apperr.Invalidf("messages: ожидается список реплик")
	errLastUser = apperr.Invalidf("последняя реплика должна быть от пользователя")
)

// Clean приводит присланные реплики к годному диалогу.
//
// Правила повторяют ядро: берутся последние MaxTurns элементов, всё,
// что не объект, пропускается, незнакомая роль считается репликой
// клиента, пробелы схлопываются, пустые реплики выбрасываются.
// requireUser — для ответа: отвечать не на вопрос клиента нечего.
func Clean(raw json.RawMessage, requireUser bool) ([]Turn, error) {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil || items == nil {
		return nil, errNotList
	}
	if len(items) > MaxTurns {
		items = items[len(items)-MaxTurns:]
	}

	turns := make([]Turn, 0, len(items))
	for _, item := range items {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(item, &m); err != nil || m == nil {
			continue
		}
		role := RoleUser
		if text(m["role"]) == string(RoleAssistant) {
			role = RoleAssistant
		}
		content := clip(strings.Join(strings.Fields(text(m["content"])), " "), MaxContent)
		if content != "" {
			turns = append(turns, Turn{Role: role, Content: content})
		}
	}

	if requireUser && (len(turns) == 0 || turns[len(turns)-1].Role != RoleUser) {
		return nil, errLastUser
	}
	return turns, nil
}

// LastQuestion — последняя реплика клиента: по ней журнал ответов
// отвечает на вопрос «о чём спрашивали».
func LastQuestion(turns []Turn) string {
	for i := len(turns) - 1; i >= 0; i-- {
		if turns[i].Role == RoleUser {
			return turns[i].Content
		}
	}
	return ""
}

// Transcript — диалог текстом для модели, которая пишет резюме.
func Transcript(turns []Turn) string {
	var b strings.Builder
	for i, t := range turns {
		if i > 0 {
			b.WriteByte('\n')
		}
		if t.Role == RoleUser {
			b.WriteString("Клиент: ")
		} else {
			b.WriteString("Консультант: ")
		}
		b.WriteString(t.Content)
	}
	return b.String()
}

// Digest — резюме без модели: последние вопросы клиента.
//
// Заявка важнее резюме. Модель недоступна, ключа нет, ответ пустой —
// менеджер всё равно получает заявку и хотя бы то, о чём спрашивали.
func Digest(turns []Turn) string {
	var asked []string
	for _, t := range turns {
		if t.Role == RoleUser {
			asked = append(asked, t.Content)
		}
	}
	if len(asked) == 0 {
		return "Диалога не было."
	}
	if len(asked) > 5 {
		asked = asked[len(asked)-5:]
	}
	return "Вопросы клиента: " + strings.Join(asked, " / ")
}

// text достаёт строку из значения любого типа: браузер присылает текст,
// но число вместо текста — не повод терять реплику.
func text(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var n json.Number
	if err := json.Unmarshal(raw, &n); err == nil {
		return n.String()
	}
	var b bool
	if err := json.Unmarshal(raw, &b); err == nil {
		return strconv.FormatBool(b)
	}
	return ""
}

// Clip подрезает строку до max символов — именно символов, а не байт:
// в кириллице предел в байтах означал бы вдвое меньше текста.
func Clip(s string, max int) string { return clip(s, max) }

func clip(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max])
}
