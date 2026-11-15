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
	Vision    Vision    `yaml:"vision"`
	OCR       OCR       `yaml:"ocr"`
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
	// AdminToken — секрет глобальных настроек RAG. «Сохранить» на
	// /settings меняет бота для всех посетителей, в том числе во время
	// демо жюри, поэтому это может только администратор стенда: прокси
	// Next после входа на /settings передаёт токен заголовком
	// X-Admin-Token. Пусто — глобальные настройки закрыты для всех;
	// песочница (overrides в /api/chat) работает и без него.
	AdminToken string `env:"EB_ADMIN_TOKEN"`
	// ManagerToken — доступ к разговорам и заявкам клиентов (экран
	// менеджера, T5). Там персональные данные, поэтому пустой токен —
	// закрыто для всех, как и с администратором.
	ManagerToken string `env:"EB_MANAGER_TOKEN"`
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

// Vision — модель, которая только переписывает текст с фото документа
// (T9, ADR 0006). Отвечает клиенту всегда Qwen: текст документа уходит в
// чат репликой клиента. Пустая модель — фото не принимаются, и кнопка
// вложения на фронте неактивна.
type Vision struct {
	Model string `yaml:"model" env:"EB_VISION_MODEL"`
	// BaseURL и APIKey — если vision-модель живёт не там же, где модель
	// ответов. Пусто — те же LLM_BASE_URL и LLM_API_KEY.
	BaseURL string        `yaml:"base_url" env:"EB_VISION_BASE_URL"`
	APIKey  string        `env:"EB_VISION_API_KEY"`
	Timeout time.Duration `yaml:"timeout" env:"EB_VISION_TIMEOUT" env-default:"60s"`
}

// OCR — пределы загружаемого документа. Файл читается в память целиком и
// нигде не хранится, поэтому его размер — это и память API.
type OCR struct {
	MaxBytes int64 `yaml:"max_bytes" env:"EB_OCR_MAX_BYTES" env-default:"10485760"`
	// MaxPages — сколько первых страниц PDF читается.
	MaxPages int `yaml:"max_pages" env:"EB_OCR_MAX_PAGES" env-default:"5"`
}

// Пределы документа, за которые настройка не выходит: больше — это уже
// не счёт и не договор, а нагрузка на память API.
const (
	MaxOCRBytes = 32 << 20
	MaxOCRPages = 50
)

// VisionBaseURL — адрес vision-модели: свой или общий с моделью ответов.
func (c *Config) VisionBaseURL() string {
	if c.Vision.BaseURL != "" {
		return c.Vision.BaseURL
	}
	return c.LLM.BaseURL
}

// VisionAPIKey — ключ vision-модели: свой или общий с моделью ответов.
func (c *Config) VisionAPIKey() string {
	if c.Vision.APIKey != "" {
		return c.Vision.APIKey
	}
	return c.LLM.APIKey
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
	// Настройки и вход администратора: перебор токена и дёрганье
	// глобальных настроек — не то, что человек делает десятки раз в минуту.
	SettingsPerMinute int `yaml:"settings_per_minute" env:"EB_LIMIT_SETTINGS_PER_MINUTE" env-default:"10"`
	SettingsBurst     int `yaml:"settings_burst" env:"EB_LIMIT_SETTINGS_BURST" env-default:"5"`
	// Экран менеджера (T5): список опрашивается раз в десять секунд, плюс
	// карточки и смена статуса — на порядок чаще настроек, но тоже не
	// скрипт.
	ManagerPerMinute int `yaml:"manager_per_minute" env:"EB_LIMIT_MANAGER_PER_MINUTE" env-default:"120"`
	ManagerBurst     int `yaml:"manager_burst" env:"EB_LIMIT_MANAGER_BURST" env-default:"30"`
	// Документы (T9): каждый — до десяти мегабайт в памяти и, для фото,
	// запрос к платной vision-модели. Человек прикладывает несколько
	// документов за разговор, а не десятки в минуту.
	OCRPerHour int `yaml:"ocr_per_hour" env:"EB_LIMIT_OCR_PER_HOUR" env-default:"30"`
	OCRBurst   int `yaml:"ocr_burst" env:"EB_LIMIT_OCR_BURST" env-default:"5"`
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

// MinSecretLen — минимальная длина токенов администратора и менеджера в бою.
const MinSecretLen = 32

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
	if c.OCR.MaxBytes <= 0 || c.OCR.MaxBytes > MaxOCRBytes {
		errs = append(errs, fmt.Errorf("EB_OCR_MAX_BYTES вне 1…%d", MaxOCRBytes))
	}
	if c.OCR.MaxPages <= 0 || c.OCR.MaxPages > MaxOCRPages {
		errs = append(errs, fmt.Errorf("EB_OCR_MAX_PAGES вне 1…%d", MaxOCRPages))
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
	// Пустые — значит закрыто; заданные, но короткие — подбираются перебором.
	for _, s := range []struct{ name, value string }{
		{"EB_ADMIN_TOKEN", c.HTTP.AdminToken}, {"EB_MANAGER_TOKEN", c.HTTP.ManagerToken},
	} {
		if s.value != "" && len(s.value) < MinSecretLen {
			errs = append(errs, fmt.Errorf("%s короче %d знаков", s.name, MinSecretLen))
		}
	}
	r := c.Retention
	if r.LeadsDays <= 0 || r.AnswersDays <= 0 || r.FeedbackDays <= 0 {
		errs = append(errs, errors.New("EB_RETENTION_*_DAYS в бою не могут быть нулевыми: бессрочное хранение персональных данных"))
	}
	l := c.Limits
	if l.ChatPerMinute <= 0 || l.ChatBurst <= 0 || l.LeadPerHour <= 0 || l.LeadBurst <= 0 ||
		l.FeedbackPerMinute <= 0 || l.FeedbackBurst <= 0 || l.SettingsPerMinute <= 0 || l.SettingsBurst <= 0 ||
		l.ManagerPerMinute <= 0 || l.ManagerBurst <= 0 ||
		l.OCRPerHour <= 0 || l.OCRBurst <= 0 {
		errs = append(errs, errors.New("пределы EB_LIMIT_* в бою не могут быть нулевыми"))
	}
	return errors.Join(errs...)
}
