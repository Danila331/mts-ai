// Package lead — заявка менеджеру: клиент оставил контакты, а бот
// пересказал, о чём шёл разговор.
package lead

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/Danila331/mts-ai/backend/internal/dialog"
)

// Пределы полей формы — те же, что были у Python-API: фронт под них
// свёрстан.
const (
	MaxName    = 200
	MaxPhone   = 50
	MaxCompany = 200
	MaxComment = 2000
)

// SummaryMaxTokens — резюме из четырёх строк, с запасом.
const SummaryMaxTokens = 400

// SummarySystem — указание модели, которая пишет резюме.
//
// «Ничего не додумывай» — главное в нём: менеджер позвонит клиенту, и
// выдуманная мощность объекта в заявке обойдётся дороже пустого поля.
const SummarySystem = `Ты готовишь заявку для менеджера МТС EnergyTool по диалогу клиента с ИИ-консультантом.
Напиши резюме на русском, только по тому, что есть в диалоге, ничего не додумывай. Формат — ровно четыре строки:
Задача клиента: …
Объект и исходные данные: … (что клиент сообщил: регион, тип объекта, мощность, потребление, оборудование; если нет — «не указаны»)
Подходящий продукт: … (какой продукт обсуждали; если не ясно — «уточнить»)
Что уточнить менеджеру: …`

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
}

// NewCode — десять случайных шестнадцатеричных знаков. Уникальность
// всё равно держит база; здесь достаточно, чтобы совпадение было
// редким, а не невозможным.
func NewCode() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
