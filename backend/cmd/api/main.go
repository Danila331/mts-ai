// Команда api — публичный API стенда и виджета EnergyTool.
//
// Ответ на вопрос строит Python-ядро (scripts/core_api.py); здесь —
// всё остальное: приём запросов фронта, поток ответа, заявки, оценки,
// журнал ответов в Postgres и пределы от злоупотребления.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"

	"github.com/Danila331/mts-ai/backend/internal/ai/llm"
	chatuc "github.com/Danila331/mts-ai/backend/internal/chat/usecase"
	"github.com/Danila331/mts-ai/backend/internal/config"
	"github.com/Danila331/mts-ai/backend/internal/core"
	"github.com/Danila331/mts-ai/backend/internal/document"
	"github.com/Danila331/mts-ai/backend/internal/document/pdftext"
	feedbackuc "github.com/Danila331/mts-ai/backend/internal/feedback/usecase"
	"github.com/Danila331/mts-ai/backend/internal/health"
	leaduc "github.com/Danila331/mts-ai/backend/internal/lead/usecase"
	"github.com/Danila331/mts-ai/backend/internal/logger"
	"github.com/Danila331/mts-ai/backend/internal/metrics"
	"github.com/Danila331/mts-ai/backend/internal/privacy"
	privacyuc "github.com/Danila331/mts-ai/backend/internal/privacy/usecase"
	"github.com/Danila331/mts-ai/backend/internal/ratelimit"
	"github.com/Danila331/mts-ai/backend/internal/storage/postgres"
	transport "github.com/Danila331/mts-ai/backend/internal/transport/http"
)

// version — сборка; задаётся при сборке: -ldflags "-X main.version=…".
var version = "dev"

func main() {
	// Подкоманда pdftext — разбор PDF клиента в отдельном процессе
	// (internal/document/pdftext): API запускает сам себя с ней.
	pdftext.RunIfChild()
	// Подкоманда forget — удаление данных человека по его запросу. Та же
	// конфигурация и та же база, но без HTTP: её запускают руками
	// (docker compose exec api /app/api forget …).
	if len(os.Args) > 1 && os.Args[1] == "forget" {
		if err := forget(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "forget:", err)
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		// Логгер мог и не собраться — пишем как есть.
		fmt.Fprintln(os.Stderr, "api:", err)
		os.Exit(1)
	}
}

// run — вся жизнь службы. Ошибка возвращается, а не роняет процесс на
// месте: так отложенные Close (пул базы, Redis) отрабатывают и на сбое.
func run() error {
	cfgPath := flag.String("config", "configs/api-local.yaml", "путь к конфигу; нет файла — только окружение")
	flag.Parse()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	log, err := logger.New(logger.Options{
		Level: cfg.Log.Level, Format: cfg.LogFormat(), Service: "api", Version: buildVersion(),
	})
	if err != nil {
		return err
	}
	// Боевой запуск без токена, базы или ядра — авария, которую лучше
	// заметить при старте, чем на первом же клиенте.
	if err := cfg.Verify(); err != nil {
		log.Error().Err(err).Msg("конфигурация непригодна")
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Схему накатывает сам API, до открытия пула: у базы на хостинге
	// нет публичного адреса, а ручной шаг при выкладке однажды забудут.
	if cfg.DB.Migrate {
		if err := postgres.Migrate(cfg.DB.DSN); err != nil {
			log.Error().Err(err).Msg("миграции")
			return err
		}
		log.Info().Msg("схема в актуальной версии")
	}

	store, err := postgres.Open(ctx, cfg.DB)
	if err != nil {
		log.Error().Err(err).Msg("база")
		return err
	}
	defer store.Close()

	var m *metrics.Metrics
	if cfg.Metrics.Port != 0 {
		m = metrics.New()
	}

	rateStore, closeRedis := rateLimits(ctx, cfg, log, m)
	defer closeRedis()

	coreClient := core.New(cfg.Core.URL, cfg.Core.Token).
		WithBreaker(cfg.Core.BreakerFailures, cfg.Core.BreakerCooldown).
		WithRetries(cfg.Core.Retries)

	model := llm.New(llm.Options{
		BaseURL:         cfg.LLM.BaseURL,
		APIKey:          cfg.LLM.APIKey,
		Model:           cfg.LLM.Model,
		ThinkingParam:   cfg.LLM.ThinkingParam,
		DisableThinking: cfg.LLM.DisableThinking,
		Timeout:         cfg.LLM.Timeout,
	})
	// Без модели заявки всё равно принимаются — с резюме из вопросов
	// клиента. В журнале видно, что модели нет.
	if !model.Configured() {
		log.Warn().Msg("модель не настроена (LLM_BASE_URL, LLM_API_KEY): резюме заявок — списком вопросов")
	}
	documents := document.New(visionModel(cfg, log), document.Options{MaxPages: cfg.OCR.MaxPages})

	if cfg.HTTP.Token == "" {
		log.Warn().Msg("EB_API_TOKEN не задан: API открыт всем — годится только для машины разработчика")
	}

	srv := transport.New(cfg, transport.Deps{
		Chat:      chatuc.New(coreClient, store, cfg.Core.Timeout).WithPassport(store, model),
		Leads:     leaduc.New(store, model).WithPassports(store),
		Feedback:  feedbackuc.New(store),
		Health:    health.New(coreClient, store),
		KB:        coreClient,
		Settings:  coreClient,
		Sessions:  store,
		Passports: store,
		Board:     store,
		Analytics: store,
		Documents: documents,
		Metrics:   m,
		RateStore: rateStore,
	}, log)

	// Очистка по сроку хранения — в фоне, до остановки службы. На
	// нескольких репликах проход делает одна: блокировка в базе.
	retention := privacyuc.NewRetention(store, privacy.Policy{
		Leads:    config.Days(cfg.Retention.LeadsDays),
		Answers:  config.Days(cfg.Retention.AnswersDays),
		Feedback: config.Days(cfg.Retention.FeedbackDays),
	}, cfg.Retention.Interval, log, func(n privacy.Counts) { m.RetentionPurged(n.Leads, n.Answers, n.Feedback, n.Sessions) })
	retentionCtx, stopRetention := context.WithCancel(context.Background())
	retentionDone := make(chan struct{})
	go func() {
		defer close(retentionDone)
		retention.Run(retentionCtx)
	}()
	log.Info().Int("leads_days", cfg.Retention.LeadsDays).Int("answers_days", cfg.Retention.AnswersDays).
		Int("feedback_days", cfg.Retention.FeedbackDays).Msg("сроки хранения")

	errc := make(chan error, 2)
	addr := fmt.Sprintf(":%d", cfg.HTTP.Port)
	go func() {
		log.Info().Str("addr", addr).Str("core", cfg.Core.URL).Msg("api слушает")
		if err := srv.Start(addr); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- fmt.Errorf("http: %w", err)
		}
	}()

	var metricsSrv *http.Server
	if m != nil {
		metricsSrv = &http.Server{
			Addr:              fmt.Sprintf(":%d", cfg.Metrics.Port),
			Handler:           metricsMux(m),
			ReadHeaderTimeout: 5 * time.Second,
		}
		go func() {
			log.Info().Str("addr", metricsSrv.Addr).Msg("метрики слушают")
			if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errc <- fmt.Errorf("metrics: %w", err)
			}
		}()
	}

	var runErr error
	select {
	case <-ctx.Done():
		log.Info().Msg("сигнал остановки")
	case runErr = <-errc:
		log.Error().Err(runErr).Msg("сервер упал")
	}

	// Дожидаемся текущих ответов: ответ ядра идёт до EB_CORE_TIMEOUT, и
	// обрывать его на середине — это и ответ клиенту, и строка журнала,
	// которая не запишется. Бюджет — не меньше потолка ответа ядра;
	// хостинг должен давать процессу столько же между SIGTERM и SIGKILL
	// (docs/deploy.md).
	budget := cfg.ShutdownBudget()
	log.Info().Dur("budget", budget).Msg("ждём текущие запросы")
	shutdown, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		log.Error().Err(err).Msg("не все запросы успели закончиться — обрываем")
		_ = srv.Close()
	}
	if metricsSrv != nil {
		_ = metricsSrv.Shutdown(shutdown)
	}
	stopRetention()
	<-retentionDone
	log.Info().Msg("api остановлен")
	return runErr
}

// visionModel — модель, которая переписывает текст с фото документа (T9).
// Только OCR: отвечает клиенту всё равно Qwen. nil — фото не принимаются.
func visionModel(cfg *config.Config, log zerolog.Logger) document.Vision {
	if cfg.Vision.Model == "" {
		log.Info().Msg("EB_VISION_MODEL не задан: фото документов не принимаются, кнопка вложения неактивна")
		return nil
	}
	client := llm.New(llm.Options{
		BaseURL: cfg.VisionBaseURL(),
		APIKey:  cfg.VisionAPIKey(),
		Model:   cfg.Vision.Model,
		// Параметры размышлений — для Qwen ответов; vision-модели их не шлём.
		ThinkingParam: "none",
		Timeout:       cfg.Vision.Timeout,
	})
	if !client.Configured() {
		log.Warn().Msg("EB_VISION_MODEL задан, но нет адреса или ключа модели: фото документов не принимаются")
		return nil
	}
	log.Info().Str("model", cfg.Vision.Model).Msg("распознавание фото документов включено")
	return client
}

// rateLimits — хранилище пределов: Redis, если задан, иначе память.
func rateLimits(ctx context.Context, cfg *config.Config, log zerolog.Logger, m *metrics.Metrics) (ratelimit.Factory, func()) {
	if cfg.Limits.RedisURL == "" {
		if cfg.Production() {
			log.Warn().Msg("EB_REDIS_URL не задан: пределы в памяти — верны только для одной реплики")
		}
		return nil, func() {}
	}
	opts, err := redis.ParseURL(cfg.Limits.RedisURL)
	if err != nil {
		// Неверный адрес — ошибка конфигурации, но не повод не принимать
		// заявки: пределы остаются в памяти, а журнал говорит почему.
		log.Error().Err(err).Msg("EB_REDIS_URL не разобран — пределы в памяти")
		return nil, func() {}
	}
	client := redis.NewClient(opts)
	pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if err := client.Ping(pctx).Err(); err != nil {
		// Redis поднимется — пределы вернутся в него сами: хранилище
		// пробует его на каждом запросе.
		log.Warn().Err(err).Msg("Redis пока недоступен — пределы в памяти, пока не ответит")
	} else {
		log.Info().Str("addr", opts.Addr).Msg("пределы в Redis")
	}
	return ratelimit.RedisFactory(client, log, m.RateStoreError), func() { _ = client.Close() }
}

func metricsMux(m *metrics.Metrics) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/metrics", m.Handler())
	return mux
}

// buildVersion — версия из сборки, а на Railway без неё — коммит, из
// которого собран образ.
func buildVersion() string {
	if version != "dev" {
		return version
	}
	if sha := os.Getenv("RAILWAY_GIT_COMMIT_SHA"); len(sha) >= 12 {
		return sha[:12]
	}
	return version
}

// forget удаляет данные человека по его запросу (152-ФЗ, ст. 14, 21):
// заявки по телефону или номеру и записи, где его номер упомянут в тексте.
//
//	api forget -phone "+7 900 123-45-67"          — показать, что будет удалено
//	api forget -phone "+7 900 123-45-67" -yes     — удалить
//	api forget -code 3f9a1c07b2 -yes
func forget(args []string) error {
	fs := flag.NewFlagSet("forget", flag.ContinueOnError)
	cfgPath := fs.String("config", "configs/api-local.yaml", "путь к конфигу; нет файла — только окружение")
	phone := fs.String("phone", "", "телефон человека, любой записи: +7 900 123-45-67")
	code := fs.String("code", "", "номер заявки")
	yes := fs.Bool("yes", false, "удалить; без флага — только показать, сколько записей найдётся")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	store, err := postgres.Open(ctx, cfg.DB)
	if err != nil {
		return err
	}
	defer store.Close()

	n, err := privacyuc.Forget(ctx, store, *phone, *code, !*yes)
	if err != nil {
		return err
	}
	verb := "найдено (ничего не удалено, для удаления добавьте -yes)"
	if *yes {
		verb = "удалено"
	}
	// В выводе нет ни телефона, ни имени: он остаётся в истории терминала.
	fmt.Printf("%s: заявок %d, ответов %d, оценок %d, сессий %d\n", verb, n.Leads, n.Answers, n.Feedback, n.Sessions)
	return nil
}
