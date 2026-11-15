// Package pdftext достаёт текстовый слой PDF — в отдельном процессе.
//
// PDF присылает посетитель, то есть кто угодно. Разбирает его
// github.com/ledongthuc/pdf (форк rsc.io/pdf, чистый Go, без
// зависимостей, без записей в базе уязвимостей Go). Библиотека сообщает
// об ошибках паникой и ловит её сама, но от злонамеренного файла есть
// беды, которые в процессе не поймать: цикл в дереве страниц — вечный
// цикл, «бомба» в сжатом потоке — гигабайты памяти. В процессе API это
// означало бы зависший или упавший API — вместе с приёмом заявок.
//
// Поэтому разбор идёт в дочернем процессе того же бинарника (подкоманда
// pdftext): файл — через stdin, текст — через stdout, на диск ничего не
// пишется. У процесса потолок времени (убивается по таймауту), памяти
// (сам выходит, перевалив за предел) и стека, и пустое окружение — ключи
// моделей и токены он не видит. Что бы ни случилось внутри, API получает
// только «не разобрал».
package pdftext

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"os"
	"os/exec"
	"runtime/debug"
	"runtime/metrics"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
)

// Command — подкоманда бинарника, в которой идёт разбор.
const Command = "pdftext"

// Пределы по умолчанию.
const (
	DefaultTimeout = 15 * time.Second
	DefaultMemory  = 256 << 20
	// maxInput — сколько дочерний процесс вообще согласен прочитать: предел
	// размера файла проверяет API, это — вторая линия.
	maxInput = 64 << 20
	// maxText — сколько текста процесс отдаёт: дальше в чат всё равно
	// уходит несколько тысяч знаков.
	maxText = 64 << 10
	// maxOutput — сколько API читает из stdout процесса.
	maxOutput = 1 << 20
)

// Options — пределы разбора.
type Options struct {
	// MaxPages — сколько первых страниц читать.
	MaxPages int
	Timeout  time.Duration
	// Memory — потолок памяти процесса в байтах.
	Memory int64
	// Path — бинарник с подкомандой pdftext; пусто — текущий.
	Path string
}

// Result — текст первых страниц.
type Result struct {
	Text string `json:"text"`
	// Pages — страниц в документе, PagesRead — сколько прочитано.
	Pages     int `json:"pages"`
	PagesRead int `json:"pages_read"`
}

var (
	// ErrMalformed — файл не разобран: битый или не PDF.
	ErrMalformed = errors.New("pdf: файл не разобран")
	// ErrEncrypted — PDF под паролем.
	ErrEncrypted = errors.New("pdf: защищён паролем")
	// ErrLimits — разбор не уложился во время или память.
	ErrLimits = errors.New("pdf: разбор не уложился в пределы")
)

// childReply — ответ дочернего процесса.
type childReply struct {
	Result
	Error string `json:"error,omitempty"`
}

// Extract читает текстовый слой первых страниц в дочернем процессе.
func Extract(ctx context.Context, data []byte, opts Options) (Result, error) {
	if opts.MaxPages <= 0 {
		opts.MaxPages = 1
	}
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultTimeout
	}
	if opts.Memory <= 0 {
		opts.Memory = DefaultMemory
	}
	path := opts.Path
	if path == "" {
		self, err := os.Executable()
		if err != nil {
			return Result{}, err
		}
		path = self
	}

	parent := ctx
	ctx, cancel := context.WithTimeout(parent, opts.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, Command,
		"-pages", strconv.Itoa(opts.MaxPages), "-memory", strconv.FormatInt(opts.Memory, 10))
	// Пустое окружение: секреты API (ключи модели, токены) процессу,
	// который разбирает чужой файл, не нужны. stderr не читаем: в тексте
	// паники бывают куски файла, а файл в журнал не пишется.
	cmd.Env = []string{"GOTRACEBACK=none"}
	cmd.Stdin = bytes.NewReader(data)
	out := &capped{max: maxOutput}
	cmd.Stdout = out
	cmd.WaitDelay = time.Second

	runErr := cmd.Run()
	if err := parent.Err(); err != nil {
		// Клиент ушёл — процесс убит вместе с запросом.
		return Result{}, err
	}
	if ctx.Err() != nil || runErr != nil {
		// Таймаут, выход по пределу памяти или падение: для вызывающего
		// это одно — файл в пределы не уложился.
		return Result{}, ErrLimits
	}
	var reply childReply
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil {
		return Result{}, ErrMalformed
	}
	switch reply.Error {
	case "":
		return reply.Result, nil
	case "encrypted":
		return Result{}, ErrEncrypted
	default:
		return Result{}, ErrMalformed
	}
}

// RunIfChild — точка входа подкоманды: если процесс запущен как
// «<бинарник> pdftext …», разбирает stdin и выходит. Её зовут первой
// строкой main и TestMain тех пакетов, чьи тесты доходят до Extract.
func RunIfChild() {
	if len(os.Args) > 1 && os.Args[1] == Command {
		os.Exit(Main(os.Stdin, os.Stdout, os.Args[2:]))
	}
}

// exitMemory — код выхода по пределу памяти.
const exitMemory = 3

// Main — тело дочернего процесса. Код выхода 0 — ответ в stdout
// (в том числе «не разобрал»), иначе — процесс не уложился в пределы.
func Main(stdin io.Reader, stdout io.Writer, args []string) int {
	fs := flag.NewFlagSet(Command, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	pages := fs.Int("pages", 1, "")
	memory := fs.Int64("memory", DefaultMemory, "")
	if err := fs.Parse(args); err != nil || *pages <= 0 || *memory <= 0 {
		return 2
	}
	// Стек: глубокая вложенность объектов — штатная ошибка, а не
	// гигабайт стека. Память: сборщик старается держаться ниже
	// половины потолка, сторож выходит, если не вышло.
	debug.SetMaxStack(64 << 20)
	debug.SetMemoryLimit(*memory / 2)
	go guardMemory(*memory)

	data, err := io.ReadAll(io.LimitReader(stdin, maxInput+1))
	if err != nil || len(data) > maxInput {
		return 2
	}
	reply := extract(data, *pages)
	if err := json.NewEncoder(stdout).Encode(reply); err != nil {
		return 2
	}
	return 0
}

// guardMemory выходит из процесса, когда рантайм занял больше limit.
func guardMemory(limit int64) {
	sample := []metrics.Sample{{Name: "/memory/classes/total:bytes"}}
	for {
		metrics.Read(sample)
		if sample[0].Value.Kind() == metrics.KindUint64 && int64(sample[0].Value.Uint64()) > limit {
			os.Exit(exitMemory)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// extract — разбор в самом дочернем процессе.
func extract(data []byte, maxPages int) (reply childReply) {
	defer func() {
		if recover() != nil {
			reply = childReply{Error: "malformed"}
		}
	}()
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		if errors.Is(err, pdf.ErrInvalidPassword) || strings.Contains(err.Error(), "encrypt") {
			return childReply{Error: "encrypted"}
		}
		return childReply{Error: "malformed"}
	}
	total := r.NumPage()
	if total <= 0 {
		return childReply{Error: "malformed"}
	}
	n := min(total, maxPages)
	var b strings.Builder
	read := 0
	for i := 1; i <= n && b.Len() < maxText; i++ {
		page := r.Page(i)
		if page.V.IsNull() {
			continue
		}
		read++
		rows, err := page.GetTextByRow()
		if err != nil {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		for _, row := range rows {
			var line []string
			for _, t := range row.Content {
				if s := strings.TrimSpace(t.S); s != "" {
					line = append(line, s)
				}
			}
			if len(line) > 0 {
				b.WriteString(strings.Join(line, " "))
				b.WriteByte('\n')
			}
		}
	}
	return childReply{Result: Result{Text: clean(b.String()), Pages: total, PagesRead: read}}
}

// clean убирает управляющие символы и битые байты: текст уйдёт в JSON
// и в чат, где они только мешают.
func clean(s string) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || r == utf8.RuneError || r == '\uFEFF' {
			return -1
		}
		return r
	}, s)
	if len(s) > maxText {
		s = strings.ToValidUTF8(s[:maxText], "")
	}
	return strings.TrimSpace(s)
}

// capped — буфер, который молча перестаёт копить после max байт.
type capped struct {
	bytes.Buffer
	max int
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.Len(); room > 0 {
		c.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
