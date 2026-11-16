package pdftext

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/document/pdftest"
)

// Разбор идёт в дочернем процессе — здесь это сам тестовый бинарник.
func TestMain(m *testing.M) {
	RunIfChild()
	os.Exit(m.Run())
}

func TestExtractCyrillicTextLayer(t *testing.T) {
	doc := pdftest.Build(
		[]string{"Счёт № 17 от 01.10.2026", "Потребитель: ООО Учебный склад", "Объём: 12 345 кВт·ч"},
		[]string{"Страница вторая"},
		[]string{"Страница третья"},
	)
	res, err := Extract(context.Background(), doc, Options{MaxPages: 2})
	require.NoError(t, err)
	assert.Equal(t, 3, res.Pages)
	assert.Equal(t, 2, res.PagesRead)
	assert.Contains(t, res.Text, "Счёт № 17 от 01.10.2026")
	assert.Contains(t, res.Text, "ООО Учебный склад")
	assert.Contains(t, res.Text, "12 345 кВт·ч")
	assert.Contains(t, res.Text, "Страница вторая")
	assert.NotContains(t, res.Text, "Страница третья", "страницы сверх предела не читаются")
	// Строки — в порядке сверху вниз, каждая своей строкой.
	assert.Less(t, strings.Index(res.Text, "Счёт"), strings.Index(res.Text, "Потребитель"))
}

func TestExtractScanHasNoText(t *testing.T) {
	res, err := Extract(context.Background(), pdftest.Scan(), Options{MaxPages: 3})
	require.NoError(t, err)
	assert.Empty(t, res.Text)
	assert.Equal(t, 1, res.Pages)
}

func TestExtractMalformed(t *testing.T) {
	for name, data := range map[string][]byte{
		"не PDF":       []byte("%PDF-1.7\nэто не pdf\n"),
		"обрезанный":   pdftest.Build([]string{"текст"})[:200],
		"пустой":       nil,
		"мусор в xref": []byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\nstartxref\n999999\n%%EOF\n"),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Extract(context.Background(), data, Options{MaxPages: 3})
			assert.ErrorIs(t, err, ErrMalformed)
		})
	}
}

// Цикл в дереве страниц вешает библиотеку навсегда: в дочернем процессе
// это таймаут, а не зависший API.
func TestExtractLoopIsKilledByTimeout(t *testing.T) {
	doc := loopDoc()
	started := time.Now()
	_, err := Extract(context.Background(), doc, Options{MaxPages: 3, Timeout: 700 * time.Millisecond})
	assert.ErrorIs(t, err, ErrLimits)
	assert.Less(t, time.Since(started), 5*time.Second)
}

// Сжатый поток на сотни мегабайт: процесс выходит по пределу памяти, а
// не раздувает API.
func TestExtractBombHitsMemoryLimit(t *testing.T) {
	doc := pdftest.Bomb(400 << 20)
	require.Less(t, len(doc), 2<<20)
	_, err := Extract(context.Background(), doc, Options{MaxPages: 1, Memory: 96 << 20, Timeout: 20 * time.Second})
	assert.ErrorIs(t, err, ErrLimits)
}

func TestExtractStopsWithCaller(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := Extract(ctx, pdftest.Build([]string{"текст"}), Options{MaxPages: 1})
	assert.ErrorIs(t, err, context.Canceled)
}

func TestChildRejectsBadArgs(t *testing.T) {
	assert.Equal(t, 2, Main(strings.NewReader(""), &strings.Builder{}, []string{"-pages", "0"}))
}

// loopDoc — дерево страниц, где узел ссылается сам на себя со счётчиком
// больше единицы.
func loopDoc() []byte {
	head := "%PDF-1.7\n"
	objs := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [2 0 R] /Count 5 >>",
	}
	var b strings.Builder
	b.WriteString(head)
	offsets := make([]int, len(objs))
	for i, o := range objs {
		offsets[i] = b.Len()
		b.WriteString(strings.Join([]string{strconv.Itoa(i + 1), " 0 obj\n", o, "\nendobj\n"}, ""))
	}
	xref := b.Len()
	b.WriteString("xref\n0 3\n0000000000 65535 f \n")
	for _, off := range offsets {
		s := strconv.Itoa(off)
		b.WriteString(strings.Repeat("0", 10-len(s)) + s + " 00000 n \n")
	}
	b.WriteString("trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n" + strconv.Itoa(xref) + "\n%%EOF\n")
	return []byte(b.String())
}
