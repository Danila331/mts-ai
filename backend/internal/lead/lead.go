// Package lead — заявка менеджеру: клиент оставил контакты, а бот
// пересказал, о чём шёл разговор.
package lead

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"encoding/json"

	"github.com/google/uuid"

	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/lead/score"
)

// Пределы полей формы — те же, что были у Python-API: фронт под них
// свёрстан.
const (
	MaxName    = 200
	MaxPhone   = 50
	MaxCompany = 200
	MaxComment = 2000
)

// SummaryMaxTokens — резюме из пяти строк, с запасом.
const SummaryMaxTokens = 500

// SummarySystem — указание модели, которая пишет резюме.
//
// «Ничего не додумывай» — главное в нём: менеджер позвонит клиенту, и
// выдуманная мощность объекта в заявке обойдётся дороже пустого поля.
// Блок структурированный (T3): задача, объект, продукт, известные
// параметры паспорта и что уточнить — последнее начинается со списка
// незаполненных полей, который посчитал скоринг (internal/lead/score).
const SummarySystem = `Ты готовишь заявку для менеджера МТС EnergyTool по диалогу клиента с ИИ-консультантом.
Напиши резюме на русском, только по тому, что есть в диалоге и паспорте задачи, ничего не додумывай. Формат — ровно пять строк:
Задача клиента: …
Объект: … (тип организации и объекта, регион; если нет — «не указаны»)
Подходящий продукт: … (какой продукт обсуждали; если не ясно — «уточнить»)
Известные параметры: … (только то, что клиент сообщил или подтвердил в паспорте: мощность, потребление, приборы, схема сбора и т. п.; если нет — «не указаны»)
Что уточнить менеджеру: … (если дан список «НЕ ЗАПОЛНЕНО», начни с него; не добавляй цены, сроки и расчёты)`

// ErrCodeTaken — номер заявки уже занят. Хранилище отдаёт его, чтобы
// сервис попробовал другой, а не отказал клиенту. Ошибка предмета, а не
// сценария: её порождает хранилище, и знать о сценариях ему незачем.
var ErrCodeTaken = errors.New("lead: номер заявки занят")

// SummarySource — кто написал резюме.
type SummarySource string

const (
	// SummaryDigest — резюме без модели: последние вопросы клиента.
	SummaryDigest SummarySource = "digest"
	// SummaryLLM — резюме написала модель.
	SummaryLLM SummarySource = "llm"
)

// Contacts — то, что клиент написал в форме сам.
type Contacts struct {
	Name    string
	Phone   string
	Company string
	Comment string
}

// Normalize подрезает поля до пределов.
//
// Подрезает, а не отвергает: клиент, чью заявку отклонили из-за
// длинного комментария, уходит и не возвращается.
func (c Contacts) Normalize() Contacts {
	return Contacts{
		Name:    dialog.Clip(strings.TrimSpace(c.Name), MaxName),
		Phone:   dialog.Clip(strings.TrimSpace(c.Phone), MaxPhone),
		Company: dialog.Clip(strings.TrimSpace(c.Company), MaxCompany),
		Comment: dialog.Clip(strings.TrimSpace(c.Comment), MaxComment),
	}
}

// Lead — заявка целиком.
type Lead struct {
	ID uuid.UUID
	// Code — номер, который видит клиент: «№3f9a1c07b2». Короче uuid и
	// читается по телефону.
	Code string
	Contacts
	Summary string
	// SummarySource — модель или список вопросов: заявки, где модель
	// не справилась, видно одним запросом.
	SummarySource SummarySource
	Messages      []dialog.Turn
	// RequestID — обращение, в котором принята заявка.
	RequestID string
	CreatedAt time.Time
	// SessionID — разговор, из которого пришла заявка; пусто — старая форма.
	SessionID string
	// Passport — паспорт задачи на момент отправки (internal/passport.View).
	Passport json.RawMessage
	// Score — оценка заявки с причинами и «что спросить» (T3).
	Score score.Score
}

// NewCode — десять случайных шестнадцатеричных знаков. Уникальность
// всё равно держит база; здесь достаточно, чтобы совпадение было
// редким, а не невозможным.
func NewCode() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
