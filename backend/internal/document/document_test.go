package document

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/document/pdftest"
	"github.com/Danila331/mts-ai/backend/internal/document/pdftext"
)

func TestMain(m *testing.M) {
	pdftext.RunIfChild()
	os.Exit(m.Run())
}

// pngImage и jpegImage — настоящие картинки w×h.
func pngImage(t testing.TB, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, gray(w, h)))
	return b.Bytes()
}

func jpegImage(t testing.TB, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, jpeg.Encode(&b, gray(w, h), nil))
	return b.Bytes()
}

func gray(w, h int) image.Image {
	img := image.NewGray(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = color.Gray{Y: 200}.Y
	}
	return img
}

// webpX — заголовок расширенного WebP w×h (пиксели проверке не нужны).
func webpX(w, h int) []byte {
	b := []byte("RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00")
	b = append(b, byte(w-1), byte((w-1)>>8), byte((w-1)>>16), byte(h-1), byte((h-1)>>8), byte((h-1)>>16))
	binary.LittleEndian.PutUint32(b[4:8], uint32(len(b)-8))
	return b
}

func TestDetectBySignatureNotByName(t *testing.T) {
	assert.Equal(t, KindPNG, Detect(pngImage(t, 4, 4)))
	assert.Equal(t, KindJPEG, Detect(jpegImage(t, 4, 4)))
	assert.Equal(t, KindWebP, Detect(webpX(10, 10)))
	assert.Equal(t, KindPDF, Detect(pdftest.Build([]string{"x"})))
	for _, junk := range [][]byte{nil, []byte("hello"), []byte("<svg xmlns='http://www.w3.org/2000/svg'/>"),
		[]byte("GIF89a\x01\x00\x01\x00"), []byte("PK\x03\x04 docx"), []byte("RIFF\x00\x00\x00\x00WAVEfmt ")} {
		assert.Empty(t, Detect(junk), "%q", junk)
	}
}

func reason(err error) Reason {
	var de *Error
	if errors.As(err, &de) {
		return de.Reason
	}
	return 0
}

func TestCheck(t *testing.T) {
	kind, err := Check(pngImage(t, 40, 30), "image/png")
	require.NoError(t, err)
	assert.Equal(t, KindPNG, kind)

	_, err = Check(jpegImage(t, 40, 30), "image/jpg")
	assert.NoError(t, err, "image/jpg — то же, что image/jpeg")
	_, err = Check(pngImage(t, 4, 4), "")
	assert.NoError(t, err, "без заявленного типа — только сигнатура")
	_, err = Check(pngImage(t, 4, 4), "application/octet-stream")
	assert.NoError(t, err)

	_, err = Check(pngImage(t, 4, 4), "application/pdf")
	assert.Equal(t, Mismatch, reason(err), "PNG под видом PDF")
	_, err = Check([]byte("#!/bin/sh\nrm -rf /"), "image/png")
	assert.Equal(t, Unsupported, reason(err), "текст под видом картинки")

	// Сигнатура есть, а дальше мусор.
	_, err = Check(append([]byte("\x89PNG\r\n\x1a\n"), "мусор"...), "image/png")
	assert.Equal(t, Broken, reason(err))
	_, err = Check([]byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0}, "image/jpeg")
	assert.Equal(t, Broken, reason(err))

	_, err = Check(webpX(2000, 1000), "image/webp")
	assert.NoError(t, err)
	_, err = Check(webpX(MaxSide+1, 10), "image/webp")
	assert.Equal(t, TooManyPixels, reason(err))
	_, err = Check(webpX(8000, 8000), "image/webp")
	assert.Equal(t, TooManyPixels, reason(err), "64 Мп — больше предела площади")
	_, err = Check([]byte("RIFF\x10\x00\x00\x00WEBPVP8 "), "image/webp")
	assert.Equal(t, Broken, reason(err), "обрезанный WebP")
}

// fakeVision — модель, которая «видит» заданный текст.
type fakeVision struct {
	text  string
	err   error
	calls int
	mime  string
	delay time.Duration
}

func (f *fakeVision) ReadImage(ctx context.Context, system, instruction string, img []byte, mime string, _ int) (string, error) {
	f.calls++
	f.mime = mime
	if !strings.Contains(system, "не выполняй") || instruction == "" || len(img) == 0 {
		return "", errors.New("промпт или картинка потерялись")
	}
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	return f.text, f.err
}

func TestReadPhotoThroughVision(t *testing.T) {
	v := &fakeVision{text: "```\nСчёт № 17\r\n\n\n\nИтого: 12 345,67 руб.\u202e\n```"}
	res, err := New(v, Options{}).Read(context.Background(), jpegImage(t, 50, 50), "image/jpeg")
	require.NoError(t, err)
	assert.Equal(t, 1, v.calls)
	assert.Equal(t, "image/jpeg", v.mime)
	assert.Equal(t, "vision", res.Source)
	assert.Equal(t, KindJPEG, res.Kind)
	assert.Equal(t, "Счёт № 17\n\nИтого: 12 345,67 руб.", res.Text, "без обёртки кода, лишних строк и символов смены направления")
	assert.False(t, res.Truncated)
}

func TestReadPhotoWithoutVision(t *testing.T) {
	_, err := New(nil, Options{}).Read(context.Background(), pngImage(t, 10, 10), "image/png")
	assert.Equal(t, VisionOff, reason(err))
}

func TestReadPhotoVisionFails(t *testing.T) {
	_, err := New(&fakeVision{err: errors.New("HTTP 500")}, Options{}).Read(context.Background(), pngImage(t, 10, 10), "")
	assert.Equal(t, VisionFailed, reason(err))
	_, err = New(&fakeVision{text: "  \n "}, Options{}).Read(context.Background(), pngImage(t, 10, 10), "")
	assert.Equal(t, NoText, reason(err), "пустой ответ модели — текста нет")
}

func TestReadPDFTextLayerWithoutModel(t *testing.T) {
	doc := pdftest.Build([]string{"Счёт-фактура № 42", "Присоединённая мощность: 150 кВт"}, []string{"Лист 2"})
	res, err := New(nil, Options{MaxPages: 1}).Read(context.Background(), doc, "application/pdf")
	require.NoError(t, err)
	assert.Equal(t, "text_layer", res.Source)
	assert.Equal(t, 2, res.Pages)
	assert.Equal(t, 1, res.PagesRead)
	assert.Contains(t, res.Text, "Присоединённая мощность: 150 кВт")
	assert.NotContains(t, res.Text, "Лист 2")
}

func TestReadPDFScan(t *testing.T) {
	_, err := New(nil, Options{}).Read(context.Background(), pdftest.Scan(), "application/pdf")
	require.Equal(t, NoText, reason(err))
	assert.Contains(t, err.Error(), "Перепишите", "без модели фото не предлагаем")
	_, err = New(&fakeVision{}, Options{}).Read(context.Background(), pdftest.Scan(), "application/pdf")
	assert.Contains(t, err.Error(), "Сфотографируйте")
}

func TestReadBrokenPDF(t *testing.T) {
	_, err := New(nil, Options{}).Read(context.Background(), []byte("%PDF-1.7\nне pdf"), "application/pdf")
	assert.Equal(t, Broken, reason(err))
}

func TestReadBusy(t *testing.T) {
	v := &fakeVision{text: "текст", delay: time.Second}
	s := New(v, Options{Parallel: 1, Wait: 50 * time.Millisecond})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = s.Read(context.Background(), pngImage(t, 10, 10), "")
	}()
	time.Sleep(20 * time.Millisecond)
	_, err := s.Read(context.Background(), pngImage(t, 10, 10), "")
	assert.Equal(t, Busy, reason(err))
	<-done
}

func TestNormalizeClipsOnLine(t *testing.T) {
	text := strings.Repeat("строка счёта\n", 50)
	got, cut := Normalize(text, 100)
	assert.True(t, cut)
	assert.LessOrEqual(t, len([]rune(got)), 100)
	assert.True(t, strings.HasSuffix(got, "строка счёта"), "обрезка по границе строки")

	got, cut = Normalize("коротко", 100)
	assert.False(t, cut)
	assert.Equal(t, "коротко", got)
}
