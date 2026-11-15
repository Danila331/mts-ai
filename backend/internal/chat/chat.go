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
)

// Имена событий потока. Порядок: stage(retrieval) → stage(generation) →
// answer → done; при сбое вместо answer приходит error.
const (
	EventStage  = "stage"
	EventAnswer = "answer"
	EventError  = "error"
	EventDone   = "done"
)

// Request — вопрос с историей диалога.
type Request struct {
	Turns []dialog.Turn
	Mode  dialog.Mode
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
}

// Record — запись журнала: ответ и то, на что он отвечал.
type Record struct {
	Answer
	Question string
	Turns    int
	// RequestID — обращение, в котором дан ответ: по нему ответ из
	// журнала находится в журнале службы и ядра.
	RequestID string
}
