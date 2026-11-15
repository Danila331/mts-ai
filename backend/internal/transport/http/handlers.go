package http

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/rs/zerolog"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/core"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/feedback"
	"github.com/Danila331/mts-ai/backend/internal/lead"
)

// healthz — проба хостинга: процесс жив и база отвечает. Ядро сюда не
// входит намеренно: его перезапуск не должен снимать с трафика приём
// заявок.
func (s *Server) healthz(c echo.Context) error {
	if err := s.deps.Health.Live(c.Request().Context()); err != nil {
		zerolog.Ctx(c.Request().Context()).Error().Err(err).Msg("база не отвечает")
		return fail(c, http.StatusServiceUnavailable, "база не отвечает")
	}
	return c.JSON(http.StatusOK, map[string]bool{"ok": true})
}

// health — состояние для шапки стенда: модель, эмбеддинги, база.
func (s *Server) health(c echo.Context) error {
	status, err := s.deps.Health.Status(c.Request().Context())
	if err != nil {
		return s.coreFail(c, err)
	}
	return c.JSON(http.StatusOK, status)
}

// kb — база знаний разделами. Отдаётся байт в байт как у ядра: это
// сотни килобайт, и разбирать их, чтобы собрать обратно, незачем.
func (s *Server) kb(c echo.Context) error {
	raw, err := s.deps.KB.KB(c.Request().Context())
	if err != nil {
		return s.coreFail(c, err)
	}
	return c.Blob(http.StatusOK, echo.MIMEApplicationJSONCharsetUTF8, raw)
}

// settings — настройки RAG ядра как есть.
func (s *Server) settings(c echo.Context) error {
	raw, err := s.deps.Settings.Settings(c.Request().Context())
	if err != nil {
		return s.coreFail(c, err)
	}
	return c.Blob(http.StatusOK, echo.MIMEApplicationJSONCharsetUTF8, raw)
}

type settingsRequest struct {
	Values json.RawMessage `json:"values"`
}

// saveSettings меняет настройки ядра. Шлюз проверяет только форму
// ({"values": {...}}); имена, типы и пределы проверяет ядро — отказ
// приходит 400 с его текстом.
func (s *Server) saveSettings(c echo.Context) error {
	var body settingsRequest
	if err := decode(c, &body); err != nil {
		return s.mapErr(c, err)
	}
	values := bytes.TrimSpace(body.Values)
	if len(values) == 0 || values[0] != '{' {
		return fail(c, http.StatusBadRequest, "values: ожидается объект {ключ: значение}")
	}
	payload, err := json.Marshal(map[string]json.RawMessage{"values": values})
	if err != nil {
		return s.mapErr(c, err)
	}
	raw, err := s.deps.Settings.SaveSettings(c.Request().Context(), payload)
	if err != nil {
		return s.coreFail(c, err)
	}
	return c.Blob(http.StatusOK, echo.MIMEApplicationJSONCharsetUTF8, raw)
}

// resetSettings возвращает настройки из окружения ядра.
func (s *Server) resetSettings(c echo.Context) error {
	raw, err := s.deps.Settings.ResetSettings(c.Request().Context())
	if err != nil {
		return s.coreFail(c, err)
	}
	return c.Blob(http.StatusOK, echo.MIMEApplicationJSONCharsetUTF8, raw)
}

type chatRequest struct {
	Messages json.RawMessage `json:"messages"`
	Mode     string          `json:"mode"`
}

// chat отвечает на вопрос потоком server-sent events.
//
// Ошибки формата и недоступность ядра отдаются до начала потока,
// обычным ответом с кодом: фронт показывает их текст. Всё, что
// случилось после, приходит событием error внутри потока.
func (s *Server) chat(c echo.Context) error {
	var body chatRequest
	if err := decode(c, &body); err != nil {
		return s.mapErr(c, err)
	}
	turns, err := dialog.Clean(body.Messages, true)
	if err != nil {
		return s.mapErr(c, err)
	}

	mode := dialog.ParseMode(body.Mode)
	relay, err := s.deps.Chat.Ask(c.Request().Context(), chat.Request{Turns: turns, Mode: mode})
	if err != nil {
		return s.coreFail(c, err)
	}

	w := c.Response()
	h := w.Header()
	h.Set(echo.HeaderContentType, "text/event-stream; charset=utf-8")
	h.Set("Cache-Control", "no-cache, no-transform")
	// Обратные прокси (nginx, edge хостинга) иначе копят поток и
	// отдают ответ одним куском в конце — стадии «ищу» и «пишу» фронт
	// тогда не увидит.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	w.Flush()

	s.deps.Metrics.StreamOpened()
	defer s.deps.Metrics.StreamClosed()

	out := &sseWriter{w: w}
	stop := out.heartbeat(s.cfg.HTTP.SSEHeartbeat)
	outcome := relay.Forward(out.event)
	stop()
	s.deps.Metrics.ChatOutcome(string(outcome), string(mode))
	return nil
}

// sseWriter пишет поток ответа. Пишут двое — пересылка событий ядра и
// heartbeat, — поэтому запись под замком: иначе комментарий мог бы
// вклиниться посреди события.
type sseWriter struct {
	mu   sync.Mutex
	w    *echo.Response
	gone bool
}

var errClientGone = errors.New("клиент закрыл соединение")

func (s *sseWriter) write(p []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gone {
		return errClientGone
	}
	if _, err := s.w.Write(p); err != nil {
		s.gone = true
		return err
	}
	s.w.Flush()
	return nil
}

func (s *sseWriter) event(ev chat.Event) error {
	var buf bytes.Buffer
	fmt.Fprintf(&buf, "event: %s\ndata: %s\n\n", ev.Name, ev.Data)
	return s.write(buf.Bytes())
}

// heartbeat шлёт в поток комментарий раз в every, пока не вызван stop.
//
// Между стадией «пишу» и ответом проходит до минуты тишины, а прокси по
// дороге рвут соединения, в которых долго ничего не идёт. Комментарий
// («: ping») спецификация SSE велит клиенту пропускать; фронт пропускает
// блоки без data. stop дожидается выхода горутины: после возврата
// обработчика писать в ответ нельзя.
func (s *sseWriter) heartbeat(every time.Duration) (stop func()) {
	if every <= 0 {
		return func() {}
	}
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if s.write([]byte(": ping\n\n")) != nil {
					return
				}
			}
		}
	}()
	return func() {
		close(done)
		wg.Wait()
	}
}

type leadRequest struct {
	Name     string          `json:"name"`
	Phone    string          `json:"phone"`
	Company  string          `json:"company"`
	Comment  string          `json:"comment"`
	Messages json.RawMessage `json:"messages"`
}

type leadResponse struct {
	ID      string `json:"id"`
	Summary string `json:"summary"`
}

// lead принимает заявку менеджеру и отвечает номером и резюме.
func (s *Server) lead(c echo.Context) error {
	var body leadRequest
	if err := decode(c, &body); err != nil {
		return s.mapErr(c, err)
	}
	l, err := s.deps.Leads.Create(c.Request().Context(), lead.Contacts{
		Name: body.Name, Phone: body.Phone, Company: body.Company, Comment: body.Comment,
	}, body.Messages)
	if err != nil {
		return s.mapErr(c, err)
	}
	s.deps.Metrics.Lead(string(l.SummarySource))
	return c.JSON(http.StatusOK, leadResponse{ID: l.Code, Summary: l.Summary})
}

type feedbackRequest struct {
	SessionID string `json:"session_id"`
	MessageID string `json:"message_id"`
	Rating    int    `json:"rating"`
	Comment   string `json:"comment"`
	Question  string `json:"question"`
	Answer    string `json:"answer"`
}

// feedback принимает 👍/👎.
func (s *Server) feedback(c echo.Context) error {
	var body feedbackRequest
	if err := decode(c, &body); err != nil {
		return s.mapErr(c, err)
	}
	err := s.deps.Feedback.Rate(c.Request().Context(), feedback.Feedback{
		SessionID: body.SessionID, MessageID: body.MessageID, Comment: body.Comment,
		Question: body.Question, Answer: body.Answer,
	}, body.Rating)
	if err != nil {
		return s.mapErr(c, err)
	}
	return c.JSON(http.StatusOK, map[string]bool{"ok": true})
}

// decode читает тело как JSON-объект. Пустое тело — пустой объект:
// так было у Python-API, и так проще проверять поля дальше одним путём.
//
// Ответ decode не пишет, только возвращает ошибку: ответ, записанный
// внутри помощника, легко не заметить снаружи и продолжить обработку
// поверх него.
func decode(c echo.Context, dst any) error {
	raw, err := io.ReadAll(c.Request().Body)
	if err != nil {
		// Предел тела (BodyLimit) обрывает чтение своей ошибкой 413 —
		// её отдаёт общий обработчик с внятным текстом.
		var he *echo.HTTPError
		if errors.As(err, &he) {
			return he
		}
		return apperr.Invalidf("не удалось прочитать запрос")
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if raw[0] != '{' {
		return apperr.Invalidf("ожидается JSON-объект")
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return apperr.Invalidf("ожидается JSON-объект с полями нужных типов")
	}
	return nil
}

// mapErr переводит ошибку в ответ: отказ клиенту — 400 с его текстом,
// ошибка HTTP — общему обработчику, остальное — 500 без подробностей
// (они в журнале).
func (s *Server) mapErr(c echo.Context, err error) error {
	if inv, ok := apperr.AsInvalid(err); ok {
		return fail(c, http.StatusBadRequest, inv.Msg)
	}
	var he *echo.HTTPError
	if errors.As(err, &he) {
		return he
	}
	zerolog.Ctx(c.Request().Context()).Error().Err(err).Str("route", c.Path()).Msg("запрос не обработан")
	return fail(c, http.StatusInternalServerError, "Что-то сломалось на нашей стороне")
}

// coreFail — ядро недоступно или отказало.
//
// Отказ ядра с кодом 4xx — ошибка запроса, и текст ядра уходит клиенту.
// Всё остальное — 502: виноват не клиент и не шлюз, а служба за ним.
func (s *Server) coreFail(c echo.Context, err error) error {
	var coreErr *core.Error
	if errors.As(err, &coreErr) && coreErr.Status >= 400 && coreErr.Status < 500 &&
		coreErr.Status != http.StatusUnauthorized {
		return fail(c, coreErr.Status, coreErr.Msg)
	}
	zerolog.Ctx(c.Request().Context()).Error().Err(err).Str("route", c.Path()).Msg("ядро не ответило")
	if errors.Is(err, core.ErrUnavailable) {
		return fail(c, http.StatusBadGateway, "Ядро консультанта не запущено или перезапускается")
	}
	return fail(c, http.StatusBadGateway, "Ядро консультанта не ответило")
}
