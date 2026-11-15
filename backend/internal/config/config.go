// Package config — настройки службы: файл для машины разработчика,
// переменные окружения для хостинга.
//
// Имена переменных — с префиксом EB_, как у Python-ядра: на Railway обе
// службы делят общие переменные (ключ модели, токен ядра), и два
// разных словаря для одного и того же однажды разъедутся.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/ilyakaznacheev/cleanenv"
)

type Config struct {
	// Env объявляет разработку. Боевым считается всё, что разработкой
	// не объявлено: обратное правило снимает проверки отсутствием
	// переменной, и боевой запуск без токена выглядит совершенно обычно.
	Env       string    `yaml:"env" env:"EB_ENV"`
	HTTP      HTTP      `yaml:"http"`
	DB        DB        `yaml:"db"`
	Core      Core      `yaml:"core"`
	LLM       LLM       `yaml:"llm"`
	Limits    Limits    `yaml:"limits"`
	Log       Log       `yaml:"log"`
	Metrics   Metrics   `yaml:"metrics"`
	Retention Retention `yaml:"retention"`
}

type HTTP struct {
	Port int `yaml:"port" env:"EB_HTTP_PORT" env-default:"8080"`
	// AllowedOrigins — для CORS. Фронт ходит через прокси Next на своём
	// же origin, поэтому список нужен только тем, кто зовёт API из
	// браузера напрямую, — например, локальной отладке.
	AllowedOrigins []string `yaml:"allowed_origins" env:"EB_ALLOWED_ORIGINS"`
	// Token — общий секрет с прокси Next на Vercel. API отвечает моделью,
	// то есть тратит деньги, и открытым в интернет ему быть незачем:
	// единственный законный клиент — сервер фронта.
	Token string `env:"EB_API_TOKEN"`
	// ShutdownTimeout — сколько ждать текущие ответы при остановке.
	// Ноль — потолок ответа ядра плюс запас (ShutdownBudget): меньше —
	// и выкладка обрывает ответы, которые ядро ещё пишет.
	ShutdownTimeout time.Duration `yaml:"shutdown_timeout" env:"EB_SHUTDOWN_TIMEOUT"`
	// SSEHeartbeat — как часто слать в поток комментарий, пока ядро
	// думает. Прокси по дороге (edge хостинга, Vercel) рвут соединение,
	// в котором долго тихо; ноль выключает.
	SSEHeartbeat time.Duration `yaml:"sse_heartbeat" env:"EB_SSE_HEARTBEAT" env-default:"15s"`
}

type DB struct {
	// DATABASE_URL — имя, под которым Railway отдаёт адрес своей базы.
	// Поддержать его — значит не переписывать ссылку руками в каждой
	// службе и не разойтись с ней после смены пароля.
	DSN      string `yaml:"dsn" env:"EB_DB_DSN,DATABASE_URL"`
	MaxConns int32  `yaml:"max_conns" env:"EB_DB_MAX_CONNS" env-default:"10"`
	// Migrate — накатывать ли схему при старте. У базы на хостинге нет
	// публичного адреса, и ручной шаг выкладки однажды забудут.
	Migrate bool `yaml:"migrate" env:"EB_DB_MIGRATE" env-default:"true"`
}

// Core — Python-ядро, которое строит ответ. Наружу оно не смотрит:
// на Railway это приватная сеть, локально — петля или сеть compose.
type Core struct {
	URL   string `yaml:"url" env:"EB_CORE_URL" env-default:"http://127.0.0.1:8788"`
	Token string `env:"EB_CORE_TOKEN"`
	// Timeout — потолок на один ответ: поиск, генерация, перезапросы
	// проверки. Ответ с размышлениями занимает до минуты, перезапрос —
	// ещё столько же; три минуты — запас, а не ожидание.
	Timeout time.Duration `yaml:"timeout" env:"EB_CORE_TIMEOUT" env-default:"3m"`
}

// LLM — модель для резюме заявки. Тот же OpenAI-совместимый прокси и
// те же переменные, что у ядра: модель одна, и настраивать её дважды
// значит однажды настроить по-разному.
type LLM struct {
	BaseURL string `yaml:"base_url" env:"LLM_BASE_URL,OPENAI_BASE_URL"`
	APIKey  string `env:"LLM_API_KEY,OPENAI_API_KEY"`
	Model   string `yaml:"model" env:"LLM_MODEL" env-default:"qwen/qwen3.8-27b"`
	// ThinkingParam — как сервер выключает размышления модели:
	// chat_template_kwargs (vLLM), reasoning (OpenRouter),
	// enable_thinking (DashScope), none.
	ThinkingParam   string        `yaml:"thinking_param" env:"EB_THINKING_PARAM" env-default:"chat_template_kwargs"`
	DisableThinking bool          `yaml:"disable_thinking" env:"EB_DISABLE_THINKING" env-default:"true"`
	Timeout         time.Duration `yaml:"timeout" env:"EB_SUMMARY_TIMEOUT" env-default:"30s"`
}

// Limits — предохранители от злоупотребления, на адрес клиента.
// Ноль выключает предел; в бою ноль не проходит Verify.
type Limits struct {
	ChatPerMinute     int `yaml:"chat_per_minute" env:"EB_LIMIT_CHAT_PER_MINUTE" env-default:"20"`
	ChatBurst         int `yaml:"chat_burst" env:"EB_LIMIT_CHAT_BURST" env-default:"5"`
	LeadPerHour       int `yaml:"lead_per_hour" env:"EB_LIMIT_LEAD_PER_HOUR" env-default:"10"`
	LeadBurst         int `yaml:"lead_burst" env:"EB_LIMIT_LEAD_BURST" env-default:"3"`
	FeedbackPerMinute int `yaml:"feedback_per_minute" env:"EB_LIMIT_FEEDBACK_PER_MINUTE" env-default:"30"`
	FeedbackBurst     int `yaml:"feedback_burst" env:"EB_LIMIT_FEEDBACK_BURST" env-default:"10"`
	// RedisURL — общее хранилище пределов для нескольких реплик. Пусто —
	// пределы в памяти процесса: верно ровно для одной реплики, на двух
	// каждый предел молча удваивается. REDIS_URL — имя, под которым
	// адрес отдаёт Redis на Railway.
	RedisURL string `yaml:"redis_url" env:"EB_REDIS_URL,REDIS_URL"`
}

// Log — журнал службы.
type Log struct {
	// Level — trace, debug, info, warn, error.
	Level string `yaml:"level" env:"EB_LOG_LEVEL" env-default:"info"`
	// Format — json или console. Пусто — console на машине разработчика,
	// json в бою: сборщикам журналов нужен JSON, человеку — текст.
	Format string `yaml:"format" env:"EB_LOG_FORMAT"`
}

// Retention — сроки хранения персональных данных (152-ФЗ, ст. 5 ч. 7):
// по достижении цели обработки данные удаляются. Заявка — это звонок
// менеджера: после него контакты в базе стенда не нужны. Журнал ответов
// и оценки содержат то, что человек написал в чат сам, — там тоже
// бывают имена и телефоны.
//
// Значения по умолчанию — предложение команды, а не решение юриста:
// окончательный срок задаёт тот, кто отвечает за обработку данных.
type Retention struct {
	LeadsDays    int `yaml:"leads_days" env:"EB_RETENTION_LEADS_DAYS" env-default:"90"`
	AnswersDays  int `yaml:"answers_days" env:"EB_RETENTION_ANSWERS_DAYS" env-default:"30"`
	FeedbackDays int `yaml:"feedback_days" env:"EB_RETENTION_FEEDBACK_DAYS" env-default:"90"`
	// Interval — как часто чистить.
	Interval time.Duration `yaml:"interval" env:"EB_RETENTION_INTERVAL" env-default:"1h"`
}

// Days — срок в днях как длительность.
func Days(n int) time.Duration { return time.Duration(n) * 24 * time.Hour }

// Metrics — метрики Prometheus.
type Metrics struct {
	// Port — отдельный порт для /metrics; ноль выключает. Отдельный, а
	// не общий с API: публичным на хостинге делается только PORT, и
	// метрики видны лишь из приватной сети, без ещё одного секрета.
	Port int `yaml:"port" env:"EB_METRICS_PORT" env-default:"9091"`
}

// Load читает файл, если он есть, иначе — только окружение.
//
// Переменные окружения перекрывают файл в обоих случаях: так на машине
// разработчика ключ модели живёт в .env, а не в файле из репозитория.
func Load(path string) (*Config, error) {
	var cfg Config

	if _, err := os.Stat(path); err == nil {
		if err := cleanenv.ReadConfig(path, &cfg); err != nil {
			return nil, fmt.Errorf("read config %s: %w", path, err)
		}
	} else if err := cleanenv.ReadEnv(&cfg); err != nil {
		return nil, fmt.Errorf("read env: %w", err)
	}

	// Хостинги отдают порт своей переменной и ждут, что процесс
	// послушает именно его. Не поддержать её — получить службу, которая
	// поднялась и никем не видна.
	if p := os.Getenv("PORT"); p != "" {
		if port, err := strconv.Atoi(p); err == nil {
			cfg.HTTP.Port = port
		}
	}

	return &cfg, nil
}

// devEnvs — значения EB_ENV, которыми разработка объявляется явно.
var devEnvs = map[string]bool{"development": true, "dev": true, "local": true, "test": true}

// Production отвечает, боевой ли это запуск.
func (c *Config) Production() bool { return !devEnvs[c.Env] }

// LogFormat — формат журнала с учётом умолчания по окружению.
func (c *Config) LogFormat() string {
	if c.Log.Format != "" {
		return c.Log.Format
	}
	if c.Production() {
		return "json"
	}
	return "console"
}

// ShutdownBudget — сколько ждать текущие ответы при остановке: заданное
// значение или потолок ответа ядра с запасом на запись в журнал.
func (c *Config) ShutdownBudget() time.Duration {
	if c.HTTP.ShutdownTimeout > 0 {
		return c.HTTP.ShutdownTimeout
	}
	return c.Core.Timeout + 15*time.Second
}

// Verify отказывается запускать бой без того, без чего он не работает
// или работает открытым для всех.
//
// На машине разработчика проверка молчит о токенах и пределах: там API
// без токена и с пустыми пределами — нормальное состояние, а не авария.
// Противоречия в самой конфигурации (порты, бюджет остановки) — ошибка
// при любом окружении.
func (c *Config) Verify() error {
	var errs []error
	// Это ошибки при любом окружении: с ними служба не поднимется или
	// поднимется не той, какой её задумали.
	if c.Metrics.Port != 0 && c.Metrics.Port == c.HTTP.Port {
		errs = append(errs, errors.New("EB_METRICS_PORT совпадает с портом API"))
	}
	if c.HTTP.ShutdownTimeout > 0 && c.HTTP.ShutdownTimeout < c.Core.Timeout {
		errs = append(errs, errors.New("EB_SHUTDOWN_TIMEOUT меньше EB_CORE_TIMEOUT: выкладка будет обрывать ответы"))
	}
	if !c.Production() {
		return errors.Join(errs...)
	}
	if c.DB.DSN == "" {
		errs = append(errs, errors.New("EB_DB_DSN (или DATABASE_URL) не задан"))
	}
	if c.Core.URL == "" {
		errs = append(errs, errors.New("EB_CORE_URL не задан"))
	}
	if c.Core.Token == "" {
		errs = append(errs, errors.New("EB_CORE_TOKEN не задан: ядро открыто всей приватной сети"))
	}
	if c.HTTP.Token == "" {
		errs = append(errs, errors.New("EB_API_TOKEN не задан: API, тратящий деньги на модель, открыт всем"))
	}
	r := c.Retention
	if r.LeadsDays <= 0 || r.AnswersDays <= 0 || r.FeedbackDays <= 0 {
		errs = append(errs, errors.New("EB_RETENTION_*_DAYS в бою не могут быть нулевыми: бессрочное хранение персональных данных"))
	}
	l := c.Limits
	if l.ChatPerMinute <= 0 || l.ChatBurst <= 0 || l.LeadPerHour <= 0 || l.LeadBurst <= 0 ||
		l.FeedbackPerMinute <= 0 || l.FeedbackBurst <= 0 {
		errs = append(errs, errors.New("пределы EB_LIMIT_* в бою не могут быть нулевыми"))
	}
	return errors.Join(errs...)
}
