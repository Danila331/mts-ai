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

	"github.com/rs/zerolog"

	"github.com/Danila331/mts-ai/backend/internal/ai/llm"
	chatuc "github.com/Danila331/mts-ai/backend/internal/chat/usecase"
	"github.com/Danila331/mts-ai/backend/internal/config"
	"github.com/Danila331/mts-ai/backend/internal/core"
	feedbackuc "github.com/Danila331/mts-ai/backend/internal/feedback/usecase"
	"github.com/Danila331/mts-ai/backend/internal/health"
	leaduc "github.com/Danila331/mts-ai/backend/internal/lead/usecase"
	"github.com/Danila331/mts-ai/backend/internal/storage/postgres"
	transport "github.com/Danila331/mts-ai/backend/internal/transport/http"
)

func main() {
	cfgPath := flag.String("config", "configs/api-local.yaml", "путь к конфигу; нет файла — только окружение")
	flag.Parse()

	log := zerolog.New(os.Stdout).With().Timestamp().Str("service", "api").Logger()

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatal().Err(err).Msg("config")
	}
	// Боевой запуск без токена, базы или ядра — авария, которую лучше
	// заметить при старте, чем на первом же клиенте.
	if err := cfg.Verify(); err != nil {
		log.Fatal().Err(err).Msg("конфигурация непригодна для боя")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Схему накатывает сам API, до открытия пула: у базы на хостинге
	// нет публичного адреса, а ручной шаг при выкладке однажды забудут.
	if cfg.DB.Migrate {
		if err := postgres.Migrate(cfg.DB.DSN); err != nil {
			log.Fatal().Err(err).Msg("миграции")
		}
		log.Info().Msg("схема в актуальной версии")
	}

	store, err := postgres.Open(ctx, cfg.DB)
	if err != nil {
		log.Fatal().Err(err).Msg("db")
	}
	defer store.Close()

	coreClient := core.New(cfg.Core.URL, cfg.Core.Token)

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
	if cfg.HTTP.Token == "" {
		log.Warn().Msg("EB_API_TOKEN не задан: API открыт всем — годится только для машины разработчика")
	}

	srv := transport.New(cfg, transport.Deps{
		Chat:     chatuc.New(coreClient, store, log, cfg.Core.Timeout),
		Leads:    leaduc.New(store, model, log),
		Feedback: feedbackuc.New(store),
		Health:   health.New(coreClient, store),
		KB:       coreClient,
	}, log)

	addr := fmt.Sprintf(":%d", cfg.HTTP.Port)
	go func() {
		log.Info().Str("addr", addr).Str("core", cfg.Core.URL).Msg("api слушает")
		if err := srv.Start(addr); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal().Err(err).Msg("http")
		}
	}()

	<-ctx.Done()

	// Дожидаемся текущих ответов: ответ модели — до минуты, и обрывать
	// его на середине хуже, чем задержать выкладку на полминуты.
	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		log.Error().Err(err).Msg("shutdown")
	}
	log.Info().Msg("api остановлен")
}
