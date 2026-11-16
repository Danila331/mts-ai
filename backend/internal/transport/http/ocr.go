package http

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/rs/zerolog"

	"github.com/Danila331/mts-ai/backend/internal/document"
)

// defaultOCRMaxBytes — предел документа, если конфигурация его не задала
// (так собирают сервер тесты).
const defaultOCRMaxBytes = 10 << 20

// isOCRUpload — запрос с документом: у него свой предел тела.
func isOCRUpload(r *http.Request) bool {
	return r.Method == http.MethodPost && r.URL.Path == "/api/ocr"
}

func (s *Server) ocrMaxBytes() int64 {
	if s.cfg.OCR.MaxBytes > 0 {
		return s.cfg.OCR.MaxBytes
	}
	return defaultOCRMaxBytes
}

type ocrInfoResponse struct {
	// Enabled — показывать ли кнопку вложения активной. Без vision-модели
	// кнопка неактивна с подсказкой (решение T9): основной сценарий — фото
	// счёта, и «приложите, но не фото» только путает.
	Enabled bool `json:"enabled"`
	Photos  bool `json:"photos"`
	// PDF — PDF с текстовым слоем читается без модели (API принимает его
	// и без EB_VISION_MODEL).
	PDF      bool     `json:"pdf"`
	Types    []string `json:"types"`
	MaxBytes int64    `json:"max_bytes"`
	MaxPages int      `json:"max_pages"`
}

// ocrInfo — что принимается: фронт по нему решает, показывать ли кнопку.
func (s *Server) ocrInfo(c echo.Context) error {
	d := s.deps.Documents
	if d == nil {
		return c.JSON(http.StatusOK, ocrInfoResponse{Types: []string{}})
	}
	return c.JSON(http.StatusOK, ocrInfoResponse{
		Enabled: d.Photos(), Photos: d.Photos(), PDF: true,
		Types: document.Types, MaxBytes: s.ocrMaxBytes(), MaxPages: d.MaxPages(),
	})
}

// ocr — документ → текст. Тело запроса — сам файл (не multipart: разбор
// multipart в Go кладёт большие части во временные файлы на диск, а файл
// клиента не должен касаться диска). Тип — по сигнатуре; Content-Type
// только сверяется с ней.
//
// Ответ — текст на проверку клиенту. Ни файл, ни текст не пишутся ни в
// базу, ни в журнал: в журнале — только тип, размер и длина текста.
func (s *Server) ocr(c echo.Context) error {
	d := s.deps.Documents
	if d == nil {
		return fail(c, http.StatusNotFound, "not found")
	}
	req := c.Request()
	limit := s.ocrMaxBytes()
	tooLarge := fmt.Sprintf("Файл больше %d МБ — уменьшите фото или приложите нужные страницы", limit>>20)
	if req.ContentLength > limit {
		return fail(c, http.StatusRequestEntityTooLarge, tooLarge)
	}
	data, err := io.ReadAll(http.MaxBytesReader(c.Response(), req.Body, limit))
	// Буфер стирается после ответа: файл не переживает запрос даже в
	// памяти процесса, пока до неё не дошёл сборщик мусора.
	defer clear(data)
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return fail(c, http.StatusRequestEntityTooLarge, tooLarge)
		}
		return fail(c, http.StatusBadRequest, "Не удалось получить файл — попробуйте ещё раз")
	}
	if len(data) == 0 {
		return fail(c, http.StatusBadRequest, "Пустой файл")
	}

	started := time.Now()
	res, err := d.Read(req.Context(), data, req.Header.Get(echo.HeaderContentType))
	log := zerolog.Ctx(req.Context())
	if err != nil {
		return s.documentFail(c, err, len(data))
	}
	log.Info().Str("kind", string(res.Kind)).Str("source", res.Source).Int("bytes", len(data)).
		Int("chars", len([]rune(res.Text))).Int("pages", res.Pages).Bool("truncated", res.Truncated).
		Dur("took", time.Since(started)).Msg("документ распознан")
	c.Response().Header().Set("Cache-Control", "no-store")
	return c.JSON(http.StatusOK, res)
}

// documentFail — отказ разбора: текст для клиента и код по причине.
func (s *Server) documentFail(c echo.Context, err error, size int) error {
	log := zerolog.Ctx(c.Request().Context())
	var de *document.Error
	if !errors.As(err, &de) {
		if errors.Is(err, context.Canceled) {
			return fail(c, http.StatusServiceUnavailable, "Запрос прерван")
		}
		return s.mapErr(c, err)
	}
	status := http.StatusUnprocessableEntity
	switch de.Reason {
	case document.Unsupported, document.Mismatch:
		status = http.StatusUnsupportedMediaType
	case document.VisionOff, document.Busy:
		status = http.StatusServiceUnavailable
	case document.VisionFailed:
		status = http.StatusBadGateway
	}
	// Причина — без содержимого файла: только тип отказа и ошибка
	// разборщика или модели.
	event := log.Info()
	if status >= 500 {
		event = log.Warn()
	}
	if de.Err != nil {
		event = event.AnErr("cause", de.Err)
	}
	event.Int("reason", int(de.Reason)).Int("bytes", size).Msg("документ не распознан")
	return fail(c, status, de.Msg)
}
