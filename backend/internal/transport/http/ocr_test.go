package http

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/ai/llm"
	chatuc "github.com/Danila331/mts-ai/backend/internal/chat/usecase"
	"github.com/Danila331/mts-ai/backend/internal/config"
	"github.com/Danila331/mts-ai/backend/internal/core"
	"github.com/Danila331/mts-ai/backend/internal/document"
	"github.com/Danila331/mts-ai/backend/internal/document/pdftest"
	"github.com/Danila331/mts-ai/backend/internal/document/pdftext"
	feedbackuc "github.com/Danila331/mts-ai/backend/internal/feedback/usecase"
	"github.com/Danila331/mts-ai/backend/internal/health"
	leaduc "github.com/Danila331/mts-ai/backend/internal/lead/usecase"
	"github.com/Danila331/mts-ai/backend/internal/metrics"
)

// PDF разбирается в дочернем процессе — здесь это тестовый бинарник.
func TestMain(m *testing.M) {
	pdftext.RunIfChild()
	os.Exit(m.Run())
}

// visionStub — OpenAI-совместимый сервер vision-модели: отвечает заданным
// текстом и запоминает, что ему прислали.
type visionStub struct {
	*httptest.Server
	mu     sync.Mutex
	bodies []map[string]any
	status int
	reply  string
}

func newVisionStub(t *testing.T, reply string) *visionStub {
	t.Helper()
	v := &visionStub{reply: reply, status: http.StatusOK}
	v.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		v.mu.Lock()
		v.bodies = append(v.bodies, body)
		status, reply := v.status, v.reply
		v.mu.Unlock()
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer vision-key" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"content": reply}}},
		})
	}))
	t.Cleanup(v.Close)
	return v
}

func (v *visionStub) requests() []map[string]any {
	v.mu.Lock()
	defer v.mu.Unlock()
	return append([]map[string]any(nil), v.bodies...)
}

// newOCRServer — сервер с приёмом документов; vision == nil — без модели.
// Журнал пишется в буфер: тесты проверяют, что в нём нет документа.
func newOCRServer(t *testing.T, vision *visionStub, mutate func(*config.Config)) (*Server, *memStore, *bytes.Buffer) {
	t.Helper()
	cfg := &config.Config{Env: "test"}
	cfg.Core.URL, cfg.Core.Token = "http://127.0.0.1:1", "core-token"
	if mutate != nil {
		mutate(cfg)
	}
	var model document.Vision
	if vision != nil {
		model = llm.New(llm.Options{BaseURL: vision.URL + "/v1", APIKey: "vision-key", Model: "energy-vision",
			ThinkingParam: "none", Timeout: 5 * time.Second})
	}
	store := &memStore{}
	cc := core.New(cfg.Core.URL, cfg.Core.Token)
	logs := &bytes.Buffer{}
	s := New(cfg, Deps{
		Chat:      chatuc.New(cc, store, time.Minute),
		Leads:     leaduc.New(store, nil),
		Feedback:  feedbackuc.New(store),
		Health:    health.New(cc, store),
		KB:        cc,
		Settings:  cc,
		Sessions:  store,
		Passports: store,
		Documents: document.New(model, document.Options{MaxPages: cfg.OCR.MaxPages}),
		Metrics:   metrics.New(),
	}, zerolog.New(logs))
	return s, store, logs
}

func upload(s *Server, contentType string, body []byte, headers ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/ocr", bytes.NewReader(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func pngBytes(t *testing.T, w, h int, pad int) []byte {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, image.NewGray(image.Rect(0, 0, w, h))))
	// Хвост после IEND декодеры пропускают: так получается PNG нужного
	// размера без огромной картинки.
	return append(b.Bytes(), bytes.Repeat([]byte{0}, pad)...)
}

type ocrBody struct {
	Text      string `json:"text"`
	Kind      string `json:"kind"`
	Source    string `json:"source"`
	Pages     int    `json:"pages"`
	PagesRead int    `json:"pages_read"`
	Truncated bool   `json:"truncated"`
	Error     string `json:"error"`
}

func decodeOCR(t *testing.T, rec *httptest.ResponseRecorder) ocrBody {
	t.Helper()
	var out ocrBody
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &out), rec.Body.String())
	return out
}

func TestOCRInfo(t *testing.T) {
	s, _, _ := newOCRServer(t, nil, nil)
	rec := do(s, http.MethodGet, "/api/ocr", "")
	require.Equal(t, http.StatusOK, rec.Code)
	var info map[string]any
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &info))
	assert.Equal(t, false, info["enabled"], "без EB_VISION_MODEL кнопка вложения неактивна")
	assert.Equal(t, false, info["photos"])
	assert.Equal(t, true, info["pdf"])
	assert.EqualValues(t, 10<<20, info["max_bytes"])

	s, _, _ = newOCRServer(t, newVisionStub(t, "x"), nil)
	rec = do(s, http.MethodGet, "/api/ocr", "")
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &info))
	assert.Equal(t, true, info["enabled"])
	assert.Contains(t, info["types"], "image/webp")

	// Без службы документов — честное «ничего не принимаем».
	bare, _ := newServer(t, "http://127.0.0.1:1", nil)
	rec = do(bare, http.MethodGet, "/api/ocr", "")
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &info))
	assert.Equal(t, false, info["enabled"])
	assert.Equal(t, http.StatusNotFound, upload(bare, "image/png", pngBytes(t, 4, 4, 0)).Code)
}

// Мок vision-модели возвращает текст — API отдаёт его клиенту на проверку.
func TestOCRPhotoThroughVisionModel(t *testing.T) {
	vision := newVisionStub(t, "Счёт № 17 от 01.10.2026\nИтого к оплате: 12 345,67 руб.")
	s, store, _ := newOCRServer(t, vision, nil)

	rec := upload(s, "image/png", pngBytes(t, 64, 48, 0))
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	out := decodeOCR(t, rec)
	assert.Equal(t, "Счёт № 17 от 01.10.2026\nИтого к оплате: 12 345,67 руб.", out.Text)
	assert.Equal(t, "png", out.Kind)
	assert.Equal(t, "vision", out.Source)

	reqs := vision.requests()
	require.Len(t, reqs, 1)
	assert.Equal(t, "energy-vision", reqs[0]["model"])
	assert.NotContains(t, reqs[0], "chat_template_kwargs", "параметры размышлений Qwen vision-модели не шлём")
	raw, _ := json.Marshal(reqs[0]["messages"])
	assert.Contains(t, string(raw), `"type":"image_url"`)
	assert.Contains(t, string(raw), "data:image/png;base64,")
	assert.Contains(t, string(raw), "ничего не добавляй")

	// Распознавание само в чат не уходит и ничего не пишет: ни ответа, ни сессии.
	assert.Zero(t, store.answerCount())
	assert.Empty(t, store.sessions)
}

func TestOCRPhotoWithoutVisionModel(t *testing.T) {
	s, _, _ := newOCRServer(t, nil, nil)
	rec := upload(s, "image/jpeg", jpegOf(t))
	assert.Equal(t, http.StatusServiceUnavailable, rec.Code)
	assert.Contains(t, decodeOCR(t, rec).Error, "Распознавание фото не подключено")
}

func TestOCRVisionModelDown(t *testing.T) {
	vision := newVisionStub(t, "")
	vision.status = http.StatusBadRequest
	s, _, logs := newOCRServer(t, vision, nil)
	rec := upload(s, "image/png", pngBytes(t, 8, 8, 0))
	assert.Equal(t, http.StatusBadGateway, rec.Code)
	assert.Contains(t, decodeOCR(t, rec).Error, "Не удалось распознать")
	assert.Contains(t, logs.String(), "документ не распознан")
}

func TestOCRPDFTextLayerWithoutModel(t *testing.T) {
	s, _, _ := newOCRServer(t, nil, func(c *config.Config) { c.OCR.MaxPages = 2 })
	doc := pdftest.Build(
		[]string{"Счёт-фактура № 42", "Потребитель: ООО Учебный склад", "Присоединённая мощность: 150 кВт"},
		[]string{"Лист 2: напряжение СН2"},
		[]string{"Лист 3"},
	)
	rec := upload(s, "application/pdf", doc)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	out := decodeOCR(t, rec)
	assert.Equal(t, "text_layer", out.Source)
	assert.Equal(t, 3, out.Pages)
	assert.Equal(t, 2, out.PagesRead, "страниц — не больше EB_OCR_MAX_PAGES")
	assert.Contains(t, out.Text, "Присоединённая мощность: 150 кВт")
	assert.Contains(t, out.Text, "Лист 2: напряжение СН2")
	assert.NotContains(t, out.Text, "Лист 3")

	rec = upload(s, "application/pdf", pdftest.Scan())
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.Contains(t, decodeOCR(t, rec).Error, "нет текстового слоя")
}

// Тип — по сигнатуре: заявленный Content-Type только сверяется.
func TestOCRSignatureNotMIME(t *testing.T) {
	s, _, _ := newOCRServer(t, newVisionStub(t, "текст"), nil)
	cases := []struct {
		name, ctype string
		body        []byte
	}{
		{"скрипт под видом PNG", "image/png", []byte("#!/bin/sh\necho hi\n")},
		{"SVG под видом картинки", "image/png", []byte("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>")},
		{"HTML под видом PDF", "application/pdf", []byte("<html><body>%PDF-1.7</body></html>")},
		{"PNG под видом PDF", "application/pdf", pngBytes(t, 4, 4, 0)},
		{"GIF", "image/gif", []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00;")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := upload(s, tc.ctype, tc.body)
			assert.Equal(t, http.StatusUnsupportedMediaType, rec.Code, rec.Body.String())
		})
	}
	// Сигнатура PNG, внутри мусор.
	rec := upload(s, "image/png", append([]byte("\x89PNG\r\n\x1a\n"), "мусор"...))
	assert.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	assert.Equal(t, http.StatusBadRequest, upload(s, "image/png", nil).Code, "пустой файл")
}

func TestOCRSizeLimit(t *testing.T) {
	s, _, _ := newOCRServer(t, newVisionStub(t, "текст"), func(c *config.Config) { c.OCR.MaxBytes = 3 << 20 })
	// Больше общего предела тела (1 МБ), но в пределе документа — проходит.
	rec := upload(s, "image/png", pngBytes(t, 8, 8, 2<<20))
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	rec = upload(s, "image/png", pngBytes(t, 8, 8, 4<<20))
	assert.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	assert.Contains(t, decodeOCR(t, rec).Error, "больше 3 МБ")

	// Без Content-Length (поток) предел тоже держится.
	req := httptest.NewRequest(http.MethodPost, "/api/ocr", io.MultiReader(bytes.NewReader(pngBytes(t, 8, 8, 0)),
		bytes.NewReader(make([]byte, 4<<20))))
	req.ContentLength = -1
	req.Header.Set("Content-Type", "image/png")
	out := httptest.NewRecorder()
	s.Handler().ServeHTTP(out, req)
	assert.Equal(t, http.StatusRequestEntityTooLarge, out.Code)

	// Остальные маршруты — по-прежнему с общим пределом.
	big := `{"messages": [{"role": "user", "content": "` + strings.Repeat("a", 2<<20) + `"}]}`
	assert.Equal(t, http.StatusRequestEntityTooLarge, do(s, http.MethodPost, "/api/chat", big).Code)
}

func TestOCRRateLimit(t *testing.T) {
	s, _, _ := newOCRServer(t, newVisionStub(t, "текст"), func(c *config.Config) {
		c.Limits.OCRPerHour, c.Limits.OCRBurst = 1, 1
	})
	assert.Equal(t, http.StatusOK, upload(s, "image/png", pngBytes(t, 8, 8, 0)).Code)
	rec := upload(s, "image/png", pngBytes(t, 8, 8, 0))
	assert.Equal(t, http.StatusTooManyRequests, rec.Code)
	assert.Contains(t, decodeOCR(t, rec).Error, "документов")
	// Предел документов не задевает вопросы.
	assert.Equal(t, http.StatusOK, do(s, http.MethodGet, "/api/ocr", "").Code)
}

// Файл нигде не остаётся: ни во временных файлах, ни в журнале, ни в
// базе. Текст документа в журнал тоже не попадает.
func TestOCRStoresNothing(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)

	const secret = "ИНН 7700000000 Тестов Тест Тестович"
	vision := newVisionStub(t, secret)
	s, store, logs := newOCRServer(t, vision, nil)

	marker := []byte("FILE-BODY-MARKER-3f9a")
	photo := append(pngBytes(t, 16, 16, 0), marker...)
	rec := upload(s, "image/png", photo)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, secret, decodeOCR(t, rec).Text)

	doc := pdftest.Build([]string{"Потребитель: " + secret})
	rec = upload(s, "application/pdf", doc)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	entries, err := os.ReadDir(tmp)
	require.NoError(t, err)
	assert.Empty(t, entries, "ни временных файлов, ни файлов разбора")

	journal := logs.String()
	assert.Contains(t, journal, "документ распознан", "факт разбора в журнале есть")
	assert.NotContains(t, journal, "Тестов", "текста документа в журнале нет")
	assert.NotContains(t, journal, "7700000000")
	assert.NotContains(t, journal, string(marker), "файла в журнале нет")

	assert.Zero(t, store.answerCount())
	assert.Empty(t, store.leads)
	assert.Empty(t, store.sessions)
}

func jpegOf(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, jpeg.Encode(&b, image.NewGray(image.Rect(0, 0, 8, 8)), nil))
	return b.Bytes()
}
