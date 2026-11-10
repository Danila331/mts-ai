package core

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/Danila331/mts-ai/backend/internal/chat"
)

// stream читает server-sent events ядра.
//
// bufio.Reader, а не Scanner: событие answer несёт промпт целиком, это
// десятки килобайт в одной строке, и Scanner с его пределом на строку
// однажды молча обрезал бы самый длинный ответ.
type stream struct {
	body io.ReadCloser
	r    *bufio.Reader
}

func newStream(body io.ReadCloser) *stream {
	return &stream{body: body, r: bufio.NewReaderSize(body, 64<<10)}
}

func (s *stream) Close() error { return s.body.Close() }

// Next отдаёт следующее событие. Поток, закончившийся посреди события,
// — это оборванный ответ, а не конец: о нём сообщается ошибкой.
func (s *stream) Next() (chat.Event, error) {
	var (
		name    string
		data    []string
		started bool
	)
	for {
		line, err := s.r.ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return chat.Event{}, err
		}
		eof := errors.Is(err, io.EOF)
		line = strings.TrimRight(line, "\r\n")

		if line == "" {
			if len(data) > 0 {
				return finish(name, data)
			}
			if eof {
				if started {
					return chat.Event{}, fmt.Errorf("поток оборвался посреди события %q", name)
				}
				return chat.Event{}, io.EOF
			}
			name, started = "", false
			continue
		}

		started = true
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			name = value
		case "data":
			data = append(data, value)
		}
		// Комментарии (": …") и незнакомые поля спецификация велит
		// пропускать.

		if eof {
			return chat.Event{}, fmt.Errorf("поток оборвался посреди события %q", name)
		}
	}
}

func finish(name string, data []string) (chat.Event, error) {
	if name == "" {
		name = "message"
	}
	raw := json.RawMessage(strings.Join(data, "\n"))
	if !json.Valid(raw) {
		return chat.Event{}, fmt.Errorf("событие %q: данные не JSON", name)
	}
	return chat.Event{Name: name, Data: raw}, nil
}
