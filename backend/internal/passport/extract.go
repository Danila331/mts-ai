package passport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"github.com/Danila331/mts-ai/backend/internal/dialog"
)

// Model — модель, которая раскладывает диалог по полям.
type Model interface {
	Configured() bool
	Complete(ctx context.Context, system, user string, maxTokens int) (string, error)
}

// ExtractMaxTokens — ответ модели: JSON на два десятка коротких полей.
const ExtractMaxTokens = 600

// ExtractSystem — промпт извлечения. Главное правило: только то, что
// сказал клиент. Ответ бота — не данные клиента, даже если он угадал.
var ExtractSystem = func() string {
	var b strings.Builder
	b.WriteString(`Ты заполняешь «паспорт задачи» для менеджера МТС EnergyTool по диалогу клиента с ИИ-консультантом.

ПРАВИЛА
- Бери ТОЛЬКО то, что клиент сказал сам в репликах «Клиент:». Реплики «Консультант:» — не данные клиента: не переноси из них ни регион, ни мощность, ни продукт, даже если клиент с ними не спорил.
- Если клиент чего-то не сказал — null. Ничего не додумывай и не пересчитывай: пиши значения так, как их назвал клиент («около 40 счётчиков», «три склада»).
- task — только одно из: снижение платежа, автоматизация учёта, поиск потерь, надёжность электроснабжения; если клиент не назвал задачу, которую можно однозначно отнести к одному из вариантов, — null.
- handoff_agreed — true, только если клиент явно согласился передать запрос менеджеру или сам попросил связаться с ним; отказ («не готов оставлять телефон») — false.

ПОЛЯ
`)
	for _, f := range Catalog {
		fmt.Fprintf(&b, "- %s — %s\n", f.Key, f.Label)
	}
	b.WriteString(`
ФОРМАТ ОТВЕТА — только JSON без пояснений:
{"fields": {"<ключ>": "<значение>" или null, ...}, "handoff_agreed": true|false}`)
	return b.String()
}()

// Update — что извлечено из диалога.
type Update struct {
	Values        map[string]string
	HandoffAgreed bool
	// Dropped — значения модели, которых нет в репликах клиента: в паспорт
	// не попали. Для журнала службы.
	Dropped []string
}

var errNoJSON = errors.New("паспорт: в ответе модели нет JSON")

// Extract раскладывает диалог по полям. Телефон ищется в репликах клиента
// и без модели; модель без ключа — только он.
func Extract(ctx context.Context, model Model, turns []dialog.Turn) (Update, error) {
	u := Update{Values: map[string]string{}}
	client := clientText(turns)
	if phone := findPhone(client); phone != "" {
		u.Values["phone"] = phone
	}
	if model == nil || !model.Configured() {
		return u, nil
	}
	raw, err := model.Complete(ctx, ExtractSystem, "ДИАЛОГ\n"+dialog.Transcript(turns), ExtractMaxTokens)
	if err != nil {
		return u, err
	}
	var out struct {
		Fields        map[string]*string `json:"fields"`
		HandoffAgreed bool               `json:"handoff_agreed"`
	}
	start, end := strings.Index(raw, "{"), strings.LastIndex(raw, "}")
	if start < 0 || end <= start {
		return u, errNoJSON
	}
	if err := json.Unmarshal([]byte(raw[start:end+1]), &out); err != nil {
		return u, fmt.Errorf("паспорт: %w", err)
	}
	u.HandoffAgreed = out.HandoffAgreed
	for key, v := range out.Fields {
		if v == nil {
			continue
		}
		clean, err := Clean(key, *v)
		if err != nil || clean == "" {
			continue
		}
		if !grounded(key, clean, client) {
			u.Dropped = append(u.Dropped, key)
			continue
		}
		if key == "phone" && u.Values["phone"] != "" {
			continue // номер из текста клиента надёжнее, чем пересказ модели
		}
		u.Values[key] = clean
	}
	return u, nil
}

// clientText — реплики клиента одной строкой, в нижнем регистре.
func clientText(turns []dialog.Turn) string {
	var b strings.Builder
	for _, t := range turns {
		if t.Role == dialog.RoleUser {
			b.WriteString(strings.ToLower(t.Content))
			b.WriteByte('\n')
		}
	}
	return b.String()
}

var phoneLike = regexp.MustCompile(`(?:\+7|8|7)?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}`)

func findPhone(text string) string {
	for _, m := range phoneLike.FindAllString(text, -1) {
		if p, ok := NormalizePhone(m); ok {
			return p
		}
	}
	return ""
}

// grounded — значение опирается на реплики клиента: все его числа есть у
// клиента, и хотя бы одно содержательное слово клиент сказал сам. Так
// регион или мощность, которые назвал бот, в паспорт не попадут, даже если
// модель извлечения их перенесла.
func grounded(key, value, client string) bool {
	if key == "task" {
		return true // закрытый список — модель относит слова клиента к варианту
	}
	clientDigits := digitsOnly(client)
	if key == "phone" {
		return strings.Contains(clientDigits, value[len(value)-10:])
	}
	for _, n := range numbers(value) {
		if !strings.Contains(client, n) && !strings.Contains(clientDigits, n) {
			return false
		}
	}
	words := stems(value)
	if len(words) == 0 {
		return len(numbers(value)) > 0
	}
	for _, w := range words {
		if strings.Contains(client, w) {
			return true
		}
	}
	return false
}

func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func numbers(s string) []string {
	var out []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	for _, r := range s {
		if r >= '0' && r <= '9' {
			cur.WriteRune(r)
		} else {
			flush()
		}
	}
	flush()
	return out
}

// stems — основы содержательных слов (от 4 букв): первые 4–5 букв, чтобы
// «складов» и «склады» совпали.
func stems(s string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) }) {
		r := []rune(w)
		if len(r) < 4 {
			continue
		}
		n := 5
		if len(r) < 6 {
			n = 4
		}
		out = append(out, string(r[:n]))
	}
	return out
}
