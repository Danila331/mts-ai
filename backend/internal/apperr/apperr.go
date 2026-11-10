// Package apperr — ошибки, которые предмет отдаёт наружу как есть.
//
// Транспорт отличает их от поломок по типу, а не по тексту: «последняя
// реплика должна быть от пользователя» — это ответ клиенту с кодом 400,
// а оборванное соединение с базой — 500 без подробностей.
package apperr

import "errors"

// Invalid — запрос не годится. Текст пишется для человека и уходит
// клиенту без изменений.
type Invalid struct{ Msg string }

func (e *Invalid) Error() string { return e.Msg }

// Invalidf — короткая запись для отказа.
func Invalidf(msg string) error { return &Invalid{Msg: msg} }

// AsInvalid достаёт отказ из цепочки обёрток.
func AsInvalid(err error) (*Invalid, bool) {
	var inv *Invalid
	ok := errors.As(err, &inv)
	return inv, ok
}
