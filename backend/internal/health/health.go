// Package health — состояние службы для фронта и для хостинга.
//
// Вопросов два, и они разные. Хостингу нужно «жив ли процесс и есть ли
// база» — от ответа зависит, пустить ли на службу трафик. Фронту нужно
// «может ли консультант ответить» — и это ещё и ядро, и модель. Свяжи
// их в один — и перезапуск ядра снимал бы с трафика весь API, вместе с
// приёмом заявок, которым ядро не нужно.
package health

import (
	"context"
	"encoding/json"
	"fmt"
)

// Core — состояние ядра.
type Core interface {
	Health(ctx context.Context) (json.RawMessage, error)
}

// DB — живость базы.
type DB interface {
	Ping(ctx context.Context) error
}

type Service struct {
	core Core
	db   DB
}

func New(core Core, db DB) *Service { return &Service{core: core, db: db} }

// Live — для хостинга: процесс отвечает, база доступна.
func (s *Service) Live(ctx context.Context) error { return s.db.Ping(ctx) }

// Status — для фронта: состояние ядра как есть плюс база.
//
// Поля ядра не толкуются: их набор принадлежит ядру и фронту, и шлюз,
// который пересобирал бы его по своему списку, однажды потерял бы новое
// поле по дороге.
func (s *Service) Status(ctx context.Context) (map[string]any, error) {
	raw, err := s.core.Health(ctx)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("состояние ядра: %w", err)
	}
	out["db"] = s.db.Ping(ctx) == nil
	if out["db"] == false {
		out["ok"] = false
	}
	return out, nil
}
