// Package requestid — сквозной идентификатор обращения.
//
// Его выдаёт транспорт на входе, он уходит в каждую строку журнала, в
// заголовок запроса к ядру и в строку журнала ответов. По нему одно
// обращение собирается целиком: шлюз → ядро → база.
package requestid

import (
	"context"
	"crypto/rand"
	"encoding/hex"
)

// Header — заголовок, в котором идентификатор ходит между службами.
const Header = "X-Request-ID"

// MaxLen — длиннее не принимаем: идентификатор попадает в журнал и в
// базу, и чужая строка произвольной длины там не нужна.
const MaxLen = 64

type key struct{}

// With кладёт идентификатор в контекст.
func With(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, key{}, id)
}

// From достаёт идентификатор; пусто — его нет.
func From(ctx context.Context) string {
	id, _ := ctx.Value(key{}).(string)
	return id
}

// New — 16 случайных байт в hex.
func New() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Valid — можно ли принять присланный снаружи идентификатор.
//
// Только буквы, цифры, «-», «_» и «.»: всё остальное — путь к подделке
// строк журнала переводами строк и управляющими символами.
func Valid(id string) bool {
	if id == "" || len(id) > MaxLen {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_', c == '.':
		default:
			return false
		}
	}
	return true
}
