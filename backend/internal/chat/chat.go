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
	// Level — уровень объяснения «проще / технически» (T16). Ядру уходит
	// только в режиме chat — одной строкой промпта.
	Level session.LevelChoice
	// HasLead — по сессии уже отправлена заявка: ядро не предлагает передать
	// разговор менеджеру второй раз. Ядру уходит только в режиме chat.
	HasLead bool
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
		// Question — уточняющий вопрос клиенту: утверждений в нём нет,
		// и его опора продукт в паспорт не добавляет.
		Question bool `json:"question"`
		Support  []struct {
			ID      string  `json:"id"`
			Doc     string  `json:"doc"`
			Overlap float64 `json:"overlap"`
		} `json:"support"`
	} `json:"citations"`
}

// MinProductOverlap — с какой доли общих слов предложения с разделом
// продукт считается обсуждённым. Тот же порог, что у продуктов в итогах
// консультации (web/src/lib/consultation-summary.ts: PRODUCT_MIN_OVERLAP).
// Подобран на ручном прогоне с живой моделью: разговор о складских
// счётчиках опирался на платформу учёта с совпадением 0,60–0,86, а раздел
// о распознавании по фото задевал случайно — 0,30–0,50, и клиенту в «Что
// подготовить» приходили пункты про фотографии.
const MinProductOverlap = 0.6

// SectionRefs — разделы базы из опоры ответа вместе с документом: по
// документу продукта паспорт узнаёт, какие продукты обсуждали. Слабая
// опора (MinProductOverlap) и опора уточняющих вопросов («Какие типы
// приборов стоят?» совпадает с разделом о распознавании по двум словам)
// продукт не добавляют.
func (a Answer) SectionRefs() []passport.SectionRef {
	var out []passport.SectionRef
	for _, c := range a.Citations {
		if c.Question {
			continue
		}
		for _, s := range c.Support {
			if s.ID != "" && s.Overlap >= MinProductOverlap {
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

// ConversationStats — наблюдаемые исходы (GET /api/stats): содержательный
// ответ, отсутствие технической ошибки и переход диалога в заявку. «Проблема
// решена» здесь не выдумывается.
type ConversationStats struct {
	Answers        int     `json:"answers"`
	Answered       int     `json:"answered"`
	NoBoundary     int     `json:"no_boundary"`
	Sessions       int     `json:"sessions"`
	Leads          int     `json:"leads"`
	LeadSessions   int     `json:"lead_sessions"`
	AnsweredRate   float64 `json:"answered_rate"`
	NoBoundaryRate float64 `json:"no_boundary_rate"`
	LeadConversion float64 `json:"lead_conversion"`
}

// Rates досчитывает доли по счётчикам.
func (s *ConversationStats) Rates() {
	if s.Answers > 0 {
		s.AnsweredRate = float64(s.Answered) / float64(s.Answers)
		s.NoBoundaryRate = float64(s.NoBoundary) / float64(s.Answers)
	}
	if s.Sessions > 0 {
		s.LeadConversion = float64(s.LeadSessions) / float64(s.Sessions)
	}
}

// DebugFields — поля события answer для стенда разработчика: промпт целиком,
// выдача поиска, вызовы модели и разбор. Виджету на чужом сайте они не
// нужны, а промпт и устройство поиска — не то, что стоит отдавать каждому
// посетителю (T35, LLM07). Журнал (Answer) их не хранит и так.
var DebugFields = []string{"prompt", "prompt_chars", "retrieval", "llm_calls", "trace"}

// PublicChannel — для канала нужна короткая выдача без полей отладки:
// виджет на сайте клиента и Telegram. Стенд (playground) и вызов без канала
// получают событие как есть.
func PublicChannel(channel string) bool {
	switch channel {
	case "embed", "telegram":
		return true
	}
	return false
}

// StripDebug вырезает из данных события answer поля отладки. Остальное —
// байт в байт как в ответе ядра, кроме порядка ключей. Данные, которые не
// объект, возвращаются как есть.
func StripDebug(data json.RawMessage) json.RawMessage {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil || m == nil {
		return data
	}
	for _, k := range DebugFields {
		delete(m, k)
	}
	out, err := json.Marshal(m)
	if err != nil {
		return data
	}
	return out
}
