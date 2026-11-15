// Package logger — журнал службы на zerolog.
//
// Один логгер на процесс, собранный здесь, и его потомки в контексте
// запроса (zerolog.Ctx): так у каждой строки журнала, написанной по
// ходу запроса, есть request_id, и разбор одного обращения — это один
// фильтр, а не сопоставление строк по времени.
package logger

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"
)

// Форматы вывода.
const (
	// FormatJSON — строка JSON на событие: для хостинга и сборщиков
	// журналов.
	FormatJSON = "json"
	// FormatConsole — цветной текст для человека за терминалом.
	FormatConsole = "console"
)

// Options — как писать журнал.
type Options struct {
	// Level — trace, debug, info, warn, error. Пусто — info.
	Level string
	// Format — json или console. Пусто — json.
	Format string
	// Service и Version попадают в каждую строку: в общем журнале
	// хостинга видно, какая служба и какая её сборка это написала.
	Service string
	Version string
	// Out — куда писать; nil — stdout.
	Out io.Writer
}

// New собирает логгер процесса и делает его логгером по умолчанию для
// zerolog.Ctx: код, получивший контекст без логгера (фоновая работа,
// тест), пишет в общий журнал, а не в никуда.
func New(o Options) (zerolog.Logger, error) {
	level := zerolog.InfoLevel
	if o.Level != "" {
		l, err := zerolog.ParseLevel(strings.ToLower(strings.TrimSpace(o.Level)))
		if err != nil || l == zerolog.NoLevel {
			return zerolog.Nop(), fmt.Errorf("уровень журнала %q: ожидается trace, debug, info, warn или error", o.Level)
		}
		level = l
	}

	out := o.Out
	if out == nil {
		out = os.Stdout
	}
	// Телефон, почта и имя из заявки не должны попасть в журнал, даже если
	// они оказались в тексте чужой ошибки (T35).
	out = MaskWriter(out)
	switch o.Format {
	case "", FormatJSON:
	case FormatConsole:
		out = zerolog.ConsoleWriter{Out: out, TimeFormat: "15:04:05.000"}
	default:
		return zerolog.Nop(), fmt.Errorf("формат журнала %q: ожидается json или console", o.Format)
	}

	// Миллисекунды дробным числом: «took»: 1532.4 читается сразу, а
	// наносекунды целым — нет.
	zerolog.TimeFieldFormat = time.RFC3339Nano
	zerolog.DurationFieldUnit = time.Millisecond
	zerolog.DurationFieldInteger = false

	ctx := zerolog.New(out).Level(level).With().Timestamp()
	if o.Service != "" {
		ctx = ctx.Str("service", o.Service)
	}
	if o.Version != "" {
		ctx = ctx.Str("version", o.Version)
	}
	log := ctx.Logger()
	zerolog.DefaultContextLogger = &log
	return log, nil
}
