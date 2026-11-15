// Package http — публичный API стенда и виджета.
//
// Контракт — тот же, что был у Python-API (web/src/lib/types.ts): фронт
// переезд не заметил. Отсюда и форма ошибки {"error": "…"} — её читает
// клиент фронта.
package http

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/rs/zerolog"
	"golang.org/x/time/rate"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	chatuc "github.com/Danila331/mts-ai/backend/internal/chat/usecase"
	"github.com/Danila331/mts-ai/backend/internal/config"
	"github.com/Danila331/mts-ai/backend/internal/feedback"
	"github.com/Danila331/mts-ai/backend/internal/lead"
)

// MaxBody — предел тела запроса. Самое объёмное, что сюда приходит, —
// диалог из сорока реплик по четыре тысячи символов; всё, что больше, —
// не диалог.
const MaxBody = "1M"

// Порты — то, что транспорт зовёт. Интерфейсы объявлены здесь, у
// потребителя: транспорту нужно ровно это, и тесты подменяют ровно это.
type (
	Chat interface {
		Ask(ctx context.Context, req chat.Request) (*chatuc.Relay, error)
	}
	Leads interface {
		Create(ctx context.Context, c lead.Contacts, messages json.RawMessage) (lead.Lead, error)
	}
	Feedback interface {
		Rate(ctx context.Context, f feedback.Feedback, rating int) error
	}
	Health interface {
		Live(ctx context.Context) error
		Status(ctx context.Context) (map[string]any, error)
	}
	KB interface {
		KB(ctx context.Context) (json.RawMessage, error)
	}
	Settings interface {
		Settings(ctx context.Context) (json.RawMessage, error)
		SaveSettings(ctx context.Context, body json.RawMessage) (json.RawMessage, error)
		ResetSettings(ctx context.Context) (json.RawMessage, error)
	}
)

// Deps — всё, из чего собирается сервер.
type Deps struct {
	Chat     Chat
	Leads    Leads
	Feedback Feedback
	Health   Health
	KB       KB
	Settings Settings
}

type Server struct {
	echo *echo.Echo
	cfg  *config.Config
	log  zerolog.Logger
	deps Deps
}

func New(cfg *config.Config, deps Deps, log zerolog.Logger) *Server {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true
	s := &Server{echo: e, cfg: cfg, log: log, deps: deps}

	e.HTTPErrorHandler = func(err error, c echo.Context) {
		if c.Response().Committed {
			return
		}
		status, msg := http.StatusInternalServerError, "Что-то сломалось на нашей стороне"
		var he *echo.HTTPError
		if errors.As(err, &he) {
			status = he.Code
			switch status {
			case http.StatusNotFound, http.StatusMethodNotAllowed:
				msg = "not found"
			case http.StatusRequestEntityTooLarge:
				msg = "слишком большой запрос"
			default:
				msg = http.StatusText(status)
			}
		}
		_ = c.JSON(status, errorBody{Error: msg})
	}

	// За прокси хостинга настоящий адрес приходит заголовком. Без этого
	// все запросы выглядят пришедшими с одного адреса, и предел по
	// адресу превращается в общий предел на всех.
	e.IPExtractor = echo.ExtractIPFromXFFHeader()

	e.Use(middleware.Recover())
	e.Use(middleware.BodyLimit(MaxBody))

	// Журнал запросов: метод, путь, статус, длительность. Тела не
	// пишем — там телефоны из заявок.
	e.Use(middleware.RequestLoggerWithConfig(middleware.RequestLoggerConfig{
		// Пробу хостинга не пишем: раз в несколько секунд — это журнал,
		// в котором из-за проб не видно запросов людей.
		Skipper:     func(c echo.Context) bool { return c.Path() == "/healthz" },
		LogMethod:   true,
		LogURI:      true,
		LogStatus:   true,
		LogLatency:  true,
		LogError:    true,
		HandleError: true,
		LogValuesFunc: func(c echo.Context, v middleware.RequestLoggerValues) error {
			event := log.Info()
			if v.Status >= 500 || v.Error != nil {
				event = log.Error().Err(v.Error)
			} else if v.Status >= 400 {
				event = log.Warn()
			}
			event.Str("method", v.Method).Str("uri", v.URI).Int("status", v.Status).
				Dur("took", v.Latency).Str("ip", s.clientIP(c)).Msg("запрос")
			return nil
		},
	}))

	// CORS нужен только тем, кто зовёт API из браузера напрямую: фронт
	// ходит через свой прокси на том же origin. Пустой список — CORS
	// выключен, и это правильное состояние для боя.
	if len(cfg.HTTP.AllowedOrigins) > 0 {
		e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
			AllowOrigins: cfg.HTTP.AllowedOrigins,
			AllowHeaders: []string{echo.HeaderOrigin, echo.HeaderContentType, echo.HeaderAuthorization},
			AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodOptions},
		}))
	}

	s.routes()
	return s
}

func (s *Server) routes() {
	s.echo.GET("/healthz", s.healthz)

	l := s.cfg.Limits
	// Ответ стоит денег на модель: десяток вопросов в минуту с одного
	// адреса — это живой человек, сотня — скрипт.
	chatLimit := s.limiter(l.ChatPerMinute, time.Minute, l.ChatBurst,
		"Слишком много вопросов подряд — подождите минуту")
	// Каждая заявка — звонок менеджера. Поток заявок с одного адреса —
	// это не клиенты.
	leadLimit := s.limiter(l.LeadPerHour, time.Hour, l.LeadBurst,
		"Заявок с этого адреса слишком много — попробуйте позже")
	feedbackLimit := s.limiter(l.FeedbackPerMinute, time.Minute, l.FeedbackBurst,
		"Слишком много оценок подряд")

	api := s.echo.Group("/api", s.requireToken)
	api.GET("/health", s.health)
	api.GET("/kb", s.kb)
	api.POST("/chat", s.chat, chatLimit)
	api.POST("/lead", s.lead, leadLimit)
	api.POST("/feedback", s.feedback, feedbackLimit)
	// Настройки RAG глобальные: стенд для жюри, «Сохранить» меняет бота для всех.
	api.GET("/settings", s.settings)
	api.POST("/settings", s.saveSettings)
	api.POST("/settings/reset", s.resetSettings)
}

// Start слушает адрес. Таймаута на запись нет намеренно: ответ идёт
// потоком до нескольких минут, и общий таймаут обрывал бы его на
// середине. Таймаут на заголовки есть — от медленных клиентов,
// держащих соединения открытыми.
func (s *Server) Start(addr string) error {
	srv := &http.Server{
		Addr:              addr,
		Handler:           s.echo,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	return s.echo.StartServer(srv)
}

func (s *Server) Shutdown(ctx context.Context) error { return s.echo.Shutdown(ctx) }

// Handler — для тестов: сервер без сокета.
func (s *Server) Handler() http.Handler { return s.echo }

type errorBody struct {
	Error string `json:"error"`
}

func fail(c echo.Context, status int, msg string) error {
	return c.JSON(status, errorBody{Error: msg})
}

// requireToken пускает к API только прокси фронта.
//
// Без заданного токена проверка выключена: так работает машина
// разработчика. В бою пустой токен не проходит Verify при старте.
func (s *Server) requireToken(next echo.HandlerFunc) echo.HandlerFunc {
	token := s.cfg.HTTP.Token
	if token == "" {
		return next
	}
	want := []byte("Bearer " + token)
	return func(c echo.Context) error {
		got := []byte(c.Request().Header.Get(echo.HeaderAuthorization))
		if subtle.ConstantTimeCompare(got, want) != 1 {
			return fail(c, http.StatusUnauthorized, "unauthorized")
		}
		return next(c)
	}
}

// clientIP — адрес человека, а не прокси.
//
// Запросы приходят через сервер Next на Vercel, и адрес соединения —
// это адрес Vercel, общий для всех. Настоящий адрес прокси передаёт
// заголовком X-Client-IP. Верить заголовку можно только от прокси, то
// есть только при заданном токене: иначе любой подставил бы чужой адрес
// и обошёл предел.
func (s *Server) clientIP(c echo.Context) string {
	if s.cfg.HTTP.Token != "" {
		if ip := strings.TrimSpace(c.Request().Header.Get("X-Client-IP")); ip != "" {
			return ip
		}
	}
	return c.RealIP()
}

// limiter — предел частоты на память процесса, по адресу клиента.
//
// Ноль выключает предел: в тестах и на машине разработчика упираться в
// него незачем, а в бою ноль не пройдёт Verify.
func (s *Server) limiter(perPeriod int, period time.Duration, burst int, message string) echo.MiddlewareFunc {
	if perPeriod <= 0 || burst <= 0 {
		return func(next echo.HandlerFunc) echo.HandlerFunc { return next }
	}
	store := middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
		Rate:  rate.Limit(float64(perPeriod) / period.Seconds()),
		Burst: burst,
		// Запись живёт немногим дольше окна: держать её вечно — течь
		// памяти, открытая любому, кто меняет адрес.
		ExpiresIn: period + time.Minute,
	})
	deny := func(c echo.Context, _ string, _ error) error {
		return fail(c, http.StatusTooManyRequests, message)
	}
	return middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store:               store,
		IdentifierExtractor: func(c echo.Context) (string, error) { return s.clientIP(c), nil },
		DenyHandler:         deny,
		ErrorHandler:        func(c echo.Context, err error) error { return deny(c, "", err) },
	})
}
