package lead

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
	"github.com/Danila331/mts-ai/backend/internal/lead/score"
	"github.com/Danila331/mts-ai/backend/internal/passport"
)

// Status — статус заявки на экране менеджера (T5). Это же разметка
// качества для пилота (T40): «нецелевая» — заявка, которая не должна
// была дойти до менеджера.
type Status string

const (
	StatusNew        Status = "new"
	StatusInProgress Status = "in_progress"
	StatusDone       Status = "done"
	StatusRejected   Status = "rejected"
)

// StatusInfo — статус и его подпись.
type StatusInfo struct {
	Status Status `json:"status"`
	Label  string `json:"label"`
}

// Statuses — все статусы в порядке показа.
var Statuses = []StatusInfo{
	{StatusNew, "Новая"},
	{StatusInProgress, "В работе"},
	{StatusDone, "Закрыта"},
	{StatusRejected, "Нецелевая"},
}

// ParseStatus — статус из запроса; пусто и неизвестное — отказ.
func ParseStatus(s string) (Status, error) {
	for _, info := range Statuses {
		if string(info.Status) == s {
			return info.Status, nil
		}
	}
	return "", apperr.Invalidf("status: new, in_progress, done или rejected")
}

// Label — подпись статуса; пусто — неизвестный.
func (s Status) Label() string {
	for _, info := range Statuses {
		if info.Status == s {
			return info.Label
		}
	}
	return ""
}

// ListItem — строка списка заявок менеджера.
type ListItem struct {
	Code      string    `json:"code"`
	CreatedAt time.Time `json:"created_at"`
	Name      string    `json:"name"`
	Company   string    `json:"company"`
	Kind      Kind      `json:"kind"`
	KindLabel string    `json:"kind_label"`
	// Grade — hot | warm | cold; пусто — заявка без оценки (старая).
	Grade       score.Grade `json:"grade"`
	GradeLabel  string      `json:"grade_label"`
	Status      Status      `json:"status"`
	StatusLabel string      `json:"status_label"`
	// Product и ProductLabel — продукт, по чек-листу которого считалась
	// оценка; general — продукт не определён.
	Product      passport.Group `json:"product"`
	ProductLabel string         `json:"product_label"`
}

// ListPage — страница списка и общее число заявок под фильтром.
type ListPage struct {
	Items []ListItem `json:"items"`
	Total int        `json:"total"`
}

// Card — заявка целиком, как её видит менеджер. История разговора
// добавляется транспортом из сессии; Messages — диалог на момент
// отправки, он остаётся, даже когда сессию удалили по сроку хранения.
type Card struct {
	ListItem
	ID            string          `json:"id"`
	Phone         string          `json:"phone"`
	Comment       string          `json:"comment"`
	Summary       string          `json:"summary"`
	SummarySource SummarySource   `json:"summary_source"`
	Callback      Callback        `json:"callback"`
	CallbackLabel string          `json:"callback_label"`
	Passport      json.RawMessage `json:"passport"`
	Score         score.Score     `json:"score"`
	SessionID     string          `json:"session_id,omitempty"`
	Messages      json.RawMessage `json:"messages"`
	StatusChanged *time.Time      `json:"status_changed_at,omitempty"`
}

// GradeLabel — подпись оценки для менеджера.
func GradeLabel(g score.Grade) string {
	switch g {
	case score.Hot:
		return "Горячая"
	case score.Warm:
		return "Тёплая"
	case score.Cold:
		return "Холодная"
	}
	return ""
}

// ProductLabel — подпись продукта; general и неизвестный — «не определён».
func ProductLabel(g passport.Group) string {
	for _, p := range passport.Products {
		if p.Group == g {
			return p.Label
		}
	}
	return "не определён"
}

// ErrNotFound — заявки с таким номером нет: не было или удалена.
var ErrNotFound = errors.New("заявка не найдена")

// NewListItem собирает строку списка с подписями; пустой тип — обратный
// звонок, пустой продукт — не определён.
func NewListItem(code string, createdAt time.Time, name, company string, kind Kind, grade score.Grade,
	status Status, product passport.Group) ListItem {
	if kind == "" {
		kind = KindCallback
	}
	if product == "" {
		product = passport.General
	}
	return ListItem{
		Code: code, CreatedAt: createdAt, Name: name, Company: company,
		Kind: kind, KindLabel: kind.Label(),
		Grade: grade, GradeLabel: GradeLabel(grade),
		Status: status, StatusLabel: status.Label(),
		Product: product, ProductLabel: ProductLabel(product),
	}
}
