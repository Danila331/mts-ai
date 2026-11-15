// Package chat — ответ консультанта на вопрос клиента.
//
// Сам ответ строит Python-ядро и присылает потоком событий: сначала
// выдача поиска, потом начало генерации, потом готовый ответ. Шлюз в
// содержимое событий не вмешивается — фронт читает их ровно в том виде,
// в каком их пишет ядро, — и вынимает из ответа только то, что ложится
// в журнал.
package chat

import (
	"context"
	"encoding/json"

	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/passport"
	"github.com/Danila331/mts-ai/backend/internal/session"
)

// Имена событий потока. Порядок: stage(retrieval) → stage(generation) →
// delta… → answer → done; при сбое вместо answer приходит error.
const (
	EventStage = "stage"
	// EventDelta — кусок ответа модели по мере генерации (T13). Шлюз
	// пересылает его как есть и в журнал не пишет: главный текст — в
	// answer, проверка ответа может его переписать.
	EventDelta  = "delta"
	EventAnswer = "answer"
	EventError  = "error"
	EventDone   = "done"
	// EventPassport — паспорт задачи после ответа (режим chat, T2). Его
	// пишет шлюз, а не ядро: приходит перед done.
	EventPassport = "passport"
)

// Request — вопрос с историей диалога.
type Request struct {
	Turns []dialog.Turn
	Mode  dialog.Mode
	// Overrides — настройки RAG только для этого ответа (песочница
	// /settings): JSON-объект как прислал фронт, ключи и пределы
	// проверяет ядро. Пусто — общие настройки.
	Overrides json.RawMessage
	// Session — разговор, к которому относится вопрос; нулевой — без
	// сессии. Ядру не уходит: модель видит только присланные реплики.
	Session session.Ref
	// Role — роль-подсказка собеседника (T15): от клиента или определённая
	// службой. Ядру уходит только в режиме chat — одной строкой промпта.
	Role session.RoleHint
	// Passport — паспорт задачи сессии (passport.View) для правил «Честные
	// нет» ядра (T26): мощность или тип организации, которые клиент указал
	// в мастере или поправил в карточке, а не написал в чат. Только chat.
	Passport json.RawMessage
}

// Event — одно событие потока. Data — JSON как его прислало ядро.
type Event struct {
	Name string
	Data json.RawMessage
}

// Stream — поток событий ответа. Next отдаёт io.EOF, когда поток
// закончился.
//
// Объявлен здесь, в предмете, а не в usecase: его реализует адаптер
// ядра, и адаптеру незачем зависеть от сценариев, чтобы знать форму
// потока.
type Stream interface {
	Next() (Event, error)
	Close() error
}

// Core — то, что строит ответ.
type Core interface {
	Chat(ctx context.Context, req Request) (Stream, error)
}

// Outcome — чем кончился ответ. Транспорт пишет его в метрики, журнал
// службы — в строку об ответе.
type Outcome string

const (
	// OutcomeAnswered — ядро прислало ответ.
	OutcomeAnswered Outcome = "answered"
	// OutcomeFallback — ответ есть, но это заглушка: модель недоступна
	// или ответ не прошёл проверку.
	OutcomeFallback Outcome = "fallback"
	// OutcomeCoreError — ядро сообщило об ошибке событием error.
	OutcomeCoreError Outcome = "core_error"
	// OutcomeBroken — поток оборвался посреди ответа.
	OutcomeBroken Outcome = "broken"
	// OutcomeEmpty — поток кончился, а ответа так и не было.
	OutcomeEmpty Outcome = "empty"
)

// ErrorEvent собирает событие об ошибке в том же виде, что пишет ядро.
func ErrorEvent(msg string) Event {
	data, _ := json.Marshal(map[string]string{"error": msg})
	return Event{Name: EventError, Data: data}
}

// DoneEvent закрывает поток.
func DoneEvent() Event { return Event{Name: EventDone, Data: json.RawMessage(`{}`)} }

// Answer — часть ответа ядра, которая ложится в журнал.
//
// Промпт, выдача поиска и цитаты в журнал не идут намеренно: это
// десятки килобайт на ответ, и всё это ядро пересчитает по тому же
// вопросу. Журнал отвечает на вопросы «о чём спрашивали», «что
// ответили» и «сколько это заняло».
type Answer struct {
	ID       string          `json:"id"`
	Text     string          `json:"text"`
	Fallback bool            `json:"fallback"`
	Error    string          `json:"error"`
	Mode     string          `json:"mode"`
	Model    string          `json:"model"`
	Timings  json.RawMessage `json:"timings"`
	Guard    json.RawMessage `json:"guard"`
	// Citations — опора предложений ответа; в журнал идут только id
	// разделов базы (Sources), без текста.
	Citations []struct {
		Support []struct {
			ID  string `json:"id"`
			Doc string `json:"doc"`
		} `json:"support"`
	} `json:"citations"`
}

// SectionRefs — разделы базы из опоры ответа вместе с документом: по
// документу продукта паспорт узнаёт, какие продукты обсуждали.
func (a Answer) SectionRefs() []passport.SectionRef {
	var out []passport.SectionRef
	for _, c := range a.Citations {
		for _, s := range c.Support {
			if s.ID != "" {
				out = append(out, passport.SectionRef{ID: s.ID, Doc: s.Doc})
			}
		}
	}
	return out
}

// Sources — id разделов базы, на которые опирается ответ, без повторов,
// в порядке первого упоминания.
func (a Answer) Sources() []string {
	seen := map[string]bool{}
	out := []string{}
	for _, c := range a.Citations {
		for _, s := range c.Support {
			if s.ID != "" && !seen[s.ID] {
				seen[s.ID] = true
				out = append(out, s.ID)
			}
		}
	}
	return out
}

// Record — запись журнала: ответ и то, на что он отвечал.
type Record struct {
	Answer
	Question string
	Turns    int
	// RequestID — обращение, в котором дан ответ: по нему ответ из
	// журнала находится в журнале службы и ядра.
	RequestID string
	// SessionID — разговор; пусто — ответ без сессии.
	SessionID string
}
