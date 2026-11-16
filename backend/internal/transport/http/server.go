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
	"net/netip"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/rs/zerolog"

	"github.com/Danila331/mts-ai/backend/internal/analytics"
	"github.com/Danila331/mts-ai/backend/internal/chat"
	chatuc "github.com/Danila331/mts-ai/backend/internal/chat/usecase"
	"github.com/Danila331/mts-ai/backend/internal/config"
	"github.com/Danila331/mts-ai/backend/internal/document"
	"github.com/Danila331/mts-ai/backend/internal/feedback"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/metrics"
	"github.com/Danila331/mts-ai/backend/internal/passport"
	"github.com/Danila331/mts-ai/backend/internal/ratelimit"
	"github.com/Danila331/mts-ai/backend/internal/requestid"
	"github.com/Danila331/mts-ai/backend/internal/session"
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
		CreateForSession(ctx context.Context, c lead.Contacts, messages json.RawMessage, sessionID string) (lead.Lead, error)
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
	Sessions interface {
		History(ctx context.Context, id string) (session.History, error)
	}
	Passports interface {
		LoadPassport(ctx context.Context, id string) (passport.Passport, error)
		SavePassport(ctx context.Context, id string, p passport.Passport) error
	}
	// Documents — текст из фото и PDF клиента (T9). Файл живёт только в
	// памяти запроса.
	Documents interface {
		Read(ctx context.Context, data []byte, declared string) (document.Result, error)
		Photos() bool
		MaxPages() int
	}
	// Board — заявки на экране менеджера (T5).
	Board interface {
		LeadList(ctx context.Context, status lead.Status, limit, offset int) (lead.ListPage, error)
		LeadCard(ctx context.Context, code string) (lead.Card, error)
		SetLeadStatus(ctx context.Context, code string, status lead.Status) error
	}
	// Stats — наблюдаемые исходы диалогов (GET /api/stats).
	Stats interface {
		Stats(ctx context.Context) (chat.ConversationStats, error)
	}
	// Analytics — отчёт экрана менеджера (T6).
	Analytics interface {
		Analytics(ctx context.Context, days int) (analytics.Report, error)
	}
	Settings interface {
		Settings(ctx context.Context) (json.RawMessage, error)
		SaveSettings(ctx context.Context, body json.RawMessage) (json.RawMessage, error)
		ResetSettings(ctx context.Context) (json.RawMessage, error)
	}
)

// Deps — всё, из чего собирается сервер.
type Deps struct {
	Chat      Chat
	Leads     Leads
	Feedback  Feedback
	Health    Health
	KB        KB
	Settings  Settings
	Sessions  Sessions
	Passports Passports
	// Board — nil выключает заявки менеджера.
	Board Board
	// Analytics — nil выключает аналитику.
	Analytics Analytics
	// Stats — nil выключает /api/stats.
	Stats Stats
	// Documents — nil выключает приём документов.
	Documents Documents
	// Metrics — nil выключает метрики.
	Metrics *metrics.Metrics
	// RateStore — хранилище пределов; nil — память процесса.
	RateStore ratelimit.Factory
}

type Server struct {
	echo *echo.Echo
	// http — сервер, который слушает сокет. Свой, а не echo.Server:
	// echo.Shutdown останавливает только собственный сервер echo, а
	// сервер, запущенный через StartServer, продолжал бы работать —
	// Shutdown возвращался мгновенно, процесс выходил, и текущие ответы
	// обрывались на середине.
	http *http.Server
	cfg  *config.Config
	log  zerolog.Logger
	deps Deps
}

func New(cfg *config.Config, deps Deps, log zerolog.Logger) *Server {
	e := echo.New()
	e.HideBanner = true
	e.HidePort = true
	s := &Server{echo: e, cfg: cfg, log: log, deps: deps}
	// Таймаута на запись нет намеренно: ответ идёт потоком до нескольких
	// минут, и общий таймаут обрывал бы его на середине. Таймаут на
	// заголовки есть — от медленных клиентов, держащих соединения
	// открытыми.
	s.http = &http.Server{
		Handler:           e,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}

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

	// Порядок важен: сначала идентификатор и логгер в контексте — их
	// видят все слои ниже; затем журнал запросов — он видит итоговый
	// код, в том числе 500 от перехваченной паники; затем перехват паник.
	e.Use(s.requestContext)
	e.Use(s.accessLog)
	e.Use(middleware.RecoverWithConfig(middleware.RecoverConfig{
		LogErrorFunc: func(c echo.Context, err error, stack []byte) error {
			zerolog.Ctx(c.Request().Context()).Error().Err(err).Str("stack", string(stack)).
				Msg("паника в обработчике")
			return err
		},
	}))
	// Документ (POST /api/ocr) больше общего предела: свой предел у него
	// в обработчике (EB_OCR_MAX_BYTES).
	e.Use(middleware.BodyLimitWithConfig(middleware.BodyLimitConfig{
		Limit:   MaxBody,
		Skipper: func(c echo.Context) bool { return isOCRUpload(c.Request()) },
	}))

	// CORS нужен только тем, кто зовёт API из браузера напрямую: фронт
	// ходит через свой прокси на том же origin. Пустой список — CORS
	// выключен, и это правильное состояние для боя.
	if len(cfg.HTTP.AllowedOrigins) > 0 {
		e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
			AllowOrigins:  cfg.HTTP.AllowedOrigins,
			AllowHeaders:  []string{echo.HeaderOrigin, echo.HeaderContentType, echo.HeaderAuthorization, requestid.Header},
			ExposeHeaders: []string{requestid.Header},
			AllowMethods:  []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodOptions},
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
	chatLimit := s.limiter(ratelimit.Rule{Name: "chat", PerPeriod: l.ChatPerMinute, Period: time.Minute, Burst: l.ChatBurst},
		"Слишком много вопросов подряд — подождите минуту")
	// Суточный потолок (T35): тот же счётчик пределов (Redis или память), окно
	// в сутки. Без давления: чат вернётся завтра, а заявка менеджеру работает всегда.
	chatDayLimit := s.limiter(ratelimit.Rule{Name: "chat_day", PerPeriod: l.ChatPerDay, Period: 24 * time.Hour, Burst: l.ChatPerDay},
		"На сегодня лимит вопросов с вашего адреса исчерпан. Завтра чат снова заработает, а заявку менеджеру можно оставить в любое время")
	// Каждая заявка — звонок менеджера. Поток заявок с одного адреса —
	// это не клиенты.
	leadLimit := s.limiter(ratelimit.Rule{Name: "lead", PerPeriod: l.LeadPerHour, Period: time.Hour, Burst: l.LeadBurst},
		"Заявок с этого адреса слишком много — попробуйте позже")
	feedbackLimit := s.limiter(ratelimit.Rule{Name: "feedback", PerPeriod: l.FeedbackPerMinute, Period: time.Minute, Burst: l.FeedbackBurst},
		"Слишком много оценок подряд")
	// Свой предел у настроек и входа администратора: перебор токена
	// упирается в него, не задевая вопросы и заявки того же адреса.
	settingsLimit := s.limiter(ratelimit.Rule{Name: "settings", PerPeriod: l.SettingsPerMinute, Period: time.Minute, Burst: l.SettingsBurst},
		"Слишком много запросов к настройкам — подождите минуту")

	// Экран менеджера опрашивает список раз в несколько секунд — у него
	// свой предел, чтобы не делить его с настройками.
	managerLimit := s.limiter(ratelimit.Rule{Name: "manager", PerPeriod: l.ManagerPerMinute, Period: time.Minute, Burst: l.ManagerBurst},
		"Слишком много запросов менеджера — подождите минуту")

	// Документ — до десяти мегабайт в памяти и, для фото, платный запрос
	// к vision-модели. Свой предел — чтобы не отнимать вопросы и заявки.
	ocrLimit := s.limiter(ratelimit.Rule{Name: "ocr", PerPeriod: l.OCRPerHour, Period: time.Hour, Burst: l.OCRBurst},
		"Слишком много документов подряд — попробуйте позже")

	api := s.echo.Group("/api", s.requireToken)
	api.GET("/health", s.health)
	if s.deps.Stats != nil {
		api.GET("/stats", s.stats)
	}
	api.GET("/kb", s.kb)
	api.POST("/chat", s.chat, chatLimit, chatDayLimit)
	api.POST("/lead", s.lead, leadLimit)
	api.POST("/feedback", s.feedback, feedbackLimit)
	// Документы (T9): что принимается — и сам документ → текст на проверку
	// клиенту. В чат текст уходит только отдельным действием клиента.
	api.GET("/ocr", s.ocrInfo)
	api.POST("/ocr", s.ocr, ocrLimit)
	// Настройки RAG: читать может каждый (страница /settings и песочница),
	// менять для всех — только администратор (EB_ADMIN_TOKEN). Песочница
	// идёт полем overrides в /api/chat и общих настроек не трогает.
	api.GET("/settings", s.settings, settingsLimit)
	api.POST("/settings", s.saveSettings, settingsLimit, s.requireAdmin)
	api.POST("/settings/reset", s.resetSettings, settingsLimit, s.requireAdmin)
	// Вход на /settings: прокси Next проверяет здесь введённый токен —
	// под тем же пределом, что и сами настройки.
	api.POST("/settings/login", s.adminLogin, settingsLimit, s.requireAdmin)
	// Разговоры клиентов — только менеджеру (EB_MANAGER_TOKEN): там их
	// реплики, то есть персональные данные.
	api.GET("/sessions/:id", s.sessionHistory, settingsLimit, s.requireManager)
	// Заявки на экране менеджера (T5): список, карточка с историей
	// разговора и смена статуса. Тот же токен, что у разговоров.
	api.GET("/leads", s.leadList, managerLimit, s.requireManager)
	api.GET("/leads/:code", s.leadCard, managerLimit, s.requireManager)
	api.PATCH("/leads/:code/status", s.leadStatus, managerLimit, s.requireManager)
	// Аналитика воронки и пробелов базы (T6): ?days=7|30.
	api.GET("/analytics", s.analytics, managerLimit, s.requireManager)
	// Паспорт задачи правит сам клиент: id сессии знает только его браузер.
	api.PATCH("/sessions/:id/passport", s.patchPassport, feedbackLimit)
}

// Start слушает адрес до Shutdown; после него — http.ErrServerClosed.
func (s *Server) Start(addr string) error {
	s.http.Addr = addr
	return s.http.ListenAndServe()
}

// Shutdown перестаёт принимать соединения и ждёт, пока текущие запросы
// — в том числе потоки ответа — закончатся, но не дольше ctx.
func (s *Server) Shutdown(ctx context.Context) error { return s.http.Shutdown(ctx) }

// Close обрывает всё сразу — когда ждать больше нельзя.
func (s *Server) Close() error { return s.http.Close() }

// Handler — для тестов: сервер без сокета.
func (s *Server) Handler() http.Handler { return s.echo }

type errorBody struct {
	Error string `json:"error"`
}

func fail(c echo.Context, status int, msg string) error {
	return c.JSON(status, errorBody{Error: msg})
}

// requestContext выдаёт обращению идентификатор и кладёт в контекст
// логгер с ним.
//
// Присланный X-Request-ID принимается, если он похож на идентификатор:
// так прокси фронта или балансировщик могут начать цепочку сами.
// Идентификатор возвращается заголовком ответа — по нему клиент, у
// которого что-то сломалось, называет обращение.
func (s *Server) requestContext(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		req := c.Request()
		id := req.Header.Get(requestid.Header)
		if !requestid.Valid(id) {
			id = requestid.New()
		}
		c.Response().Header().Set(requestid.Header, id)

		log := s.log.With().Str("request_id", id).Logger()
		ctx := requestid.With(log.WithContext(req.Context()), id)
		c.SetRequest(req.WithContext(ctx))
		return next(c)
	}
}

// accessLog — строка журнала и метрики на каждый запрос: метод, маршрут,
// код, размер, длительность, адрес клиента. Тела не пишем — там телефоны
// из заявок.
func (s *Server) accessLog(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		started := time.Now()
		err := next(c)
		if err != nil {
			// Ответ пишет общий обработчик; дальше ошибка не идёт, чтобы
			// echo не записал ответ второй раз.
			c.Error(err)
		}
		took := time.Since(started)

		req, res := c.Request(), c.Response()
		route := c.Path()
		if route == "" {
			route = "unmatched"
		}
		s.deps.Metrics.ObserveHTTP(route, req.Method, res.Status, took)

		// Пробу хостинга не пишем: раз в несколько секунд — это журнал,
		// в котором из-за проб не видно запросов людей.
		if route == "/healthz" && res.Status < 400 {
			return nil
		}
		log := zerolog.Ctx(req.Context())
		event := log.Info()
		switch {
		case res.Status >= 500:
			event = log.Error()
		case res.Status >= 400:
			event = log.Warn()
		}
		if err != nil {
			event = event.Err(err)
		}
		event.Str("method", req.Method).Str("route", route).Str("uri", req.RequestURI).
			Int("status", res.Status).Int64("bytes_out", res.Size).Dur("took", took).
			Str("ip", s.clientIP(c)).Msg("запрос")
		return nil
	}
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

// AdminHeader — заголовок с токеном администратора от прокси Next.
const AdminHeader = "X-Admin-Token"

// ManagerHeader — заголовок с токеном менеджера от прокси Next.
const ManagerHeader = "X-Manager-Token"

// requireAdmin пускает к глобальным настройкам только администратора.
//
// В отличие от requireToken, пустой токен не открывает доступ, а
// закрывает: машина разработчика без EB_ADMIN_TOKEN получает песочницу,
// как любой посетитель, — менять бота для всех по умолчанию нельзя.
func (s *Server) requireAdmin(next echo.HandlerFunc) echo.HandlerFunc {
	return requireSecret(s.cfg.HTTP.AdminToken, AdminHeader, "Глобальные настройки меняет только администратор стенда")(next)
}

// requireManager пускает к разговорам и заявкам только менеджера. Пустой
// EB_MANAGER_TOKEN — закрыто для всех.
func (s *Server) requireManager(next echo.HandlerFunc) echo.HandlerFunc {
	return requireSecret(s.cfg.HTTP.ManagerToken, ManagerHeader, "Разговоры клиентов видит только менеджер")(next)
}

func requireSecret(token, header, msg string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			got := c.Request().Header.Get(header)
			if token == "" || got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				return fail(c, http.StatusUnauthorized, msg)
			}
			return next(c)
		}
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
		// Только настоящий адрес: произвольная строка стала бы ключом
		// предела и записью в журнале.
		if ip := parseIP(c.Request().Header.Get("X-Client-IP")); ip != "" {
			return ip
		}
	}
	return c.RealIP()
}

// parseIP отдаёт канонический адрес или пустую строку, если это не адрес.
func parseIP(raw string) string {
	addr, err := netip.ParseAddr(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return addr.Unmap().String()
}

// limiter — предел частоты по адресу клиента.
//
// Хранилище — RateStore (Redis на несколько реплик) или память процесса.
// Ноль выключает предел: в тестах и на машине разработчика упираться в
// него незачем, а в бою ноль не пройдёт Verify.
func (s *Server) limiter(rule ratelimit.Rule, message string) echo.MiddlewareFunc {
	if rule.PerPeriod <= 0 || rule.Burst <= 0 {
		return func(next echo.HandlerFunc) echo.HandlerFunc { return next }
	}
	store := ratelimit.Memory(rule)
	if s.deps.RateStore != nil {
		store = s.deps.RateStore(rule)
	}
	deny := func(c echo.Context, _ string, _ error) error {
		s.deps.Metrics.RateLimited(rule.Name)
		return fail(c, http.StatusTooManyRequests, message)
	}
	return middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store:               store,
		IdentifierExtractor: func(c echo.Context) (string, error) { return s.clientIP(c), nil },
		DenyHandler:         deny,
		ErrorHandler:        func(c echo.Context, err error) error { return deny(c, "", err) },
	})
}
