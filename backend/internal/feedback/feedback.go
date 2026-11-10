// Package feedback — оценка ответа консультанта: 👍 или 👎 с
// комментарием.
package feedback

import (
	"strings"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
)

// Rating — 1 или -1. Третьего не бывает: шкала из двух кнопок, и
// «ноль» в базе означал бы рассинхрон фронта с сервером, а не мнение.
type Rating int

const (
	Like    Rating = 1
	Dislike Rating = -1
)

// ParseRating проверяет оценку. В базе стоит тот же CHECK; проверка
// здесь превращает его нарушение во внятный 400, а не в 500.
func ParseRating(v int) (Rating, error) {
	switch Rating(v) {
	case Like, Dislike:
		return Rating(v), nil
	}
	return 0, apperr.Invalidf("rating: ожидается 1 или -1")
}

// Feedback — оценка вместе с тем, что оценивали. Вопрос и ответ
// хранятся рядом с оценкой: журнал ответов может не сохраниться, а
// «плохо» без того, что именно было плохо, разбирать не по чему.
type Feedback struct {
	SessionID string
	MessageID string
	Rating    Rating
	Comment   string
	Question  string
	Answer    string
}

// Normalize подрезает поля до пределов.
func (f Feedback) Normalize() Feedback {
	f.SessionID = dialog.Clip(strings.TrimSpace(f.SessionID), 64)
	f.MessageID = dialog.Clip(strings.TrimSpace(f.MessageID), 64)
	f.Comment = dialog.Clip(strings.TrimSpace(f.Comment), 2000)
	f.Question = dialog.Clip(strings.TrimSpace(f.Question), dialog.MaxContent)
	f.Answer = dialog.Clip(strings.TrimSpace(f.Answer), 2*dialog.MaxContent)
	return f
}
