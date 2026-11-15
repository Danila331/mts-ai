// Package ratelimit — хранилища пределов частоты для транспорта.
//
// Предел в памяти процесса верен ровно для одной реплики: на двух
// каждый клиент получает удвоенный предел, и никто этого не замечает.
// Поэтому основное хранилище — Redis, общий для всех реплик, а память —
// запасной путь: Redis недоступен — пределы продолжают действовать,
// пусть и на реплику, а не отказывают всем подряд.
package ratelimit

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/go-redis/redis_rate/v10"
	"github.com/labstack/echo/v4/middleware"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"golang.org/x/time/rate"
)

// Store — хранилище предела; совпадает с middleware.RateLimiterStore echo.
type Store = middleware.RateLimiterStore

// Rule — один предел: PerPeriod запросов за Period с запасом Burst.
type Rule struct {
	// Name — имя предела в ключах Redis, журнале и метриках.
	Name      string
	PerPeriod int
	Period    time.Duration
	Burst     int
}

// Factory собирает хранилище под предел.
type Factory func(Rule) Store

// Memory — предел в памяти процесса.
func Memory(r Rule) Store {
	return middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
		Rate:  rateOf(r),
		Burst: r.Burst,
		// Запись живёт немногим дольше окна: держать её вечно — течь
		// памяти, открытая любому, кто меняет адрес.
		ExpiresIn: r.Period + time.Minute,
	})
}

// redisTimeout — сколько ждать Redis на один запрос. Предел проверяется
// на каждом запросе, и медленный Redis не должен становиться медленным
// API: дольше — запасной путь в памяти.
const redisTimeout = 250 * time.Millisecond

type redisStore struct {
	limiter *redis_rate.Limiter
	limit   redis_rate.Limit
	prefix  string
}

// Redis — предел, общий для всех реплик (GCRA в Redis, redis_rate).
func Redis(client redis.UniversalClient, r Rule) Store {
	return &redisStore{
		limiter: redis_rate.NewLimiter(client),
		limit:   redis_rate.Limit{Rate: r.PerPeriod, Period: r.Period, Burst: r.Burst},
		prefix:  "eb:rl:" + r.Name + ":",
	}
}

func (s *redisStore) Allow(id string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), redisTimeout)
	defer cancel()
	res, err := s.limiter.Allow(ctx, s.prefix+id, s.limit)
	if err != nil {
		return false, err
	}
	return res.Allowed > 0, nil
}

// Fallback — основное хранилище, а при его ошибке — запасное.
//
// Ошибка основного не отказывает клиенту: отказ всем из-за упавшего
// Redis — это авария API из-за вспомогательной службы. onError
// вызывается на каждую ошибку (для метрик); в журнал пишется не чаще
// раза в logEvery, чтобы лежащий Redis не заливал журнал.
func Fallback(primary, secondary Store, log zerolog.Logger, rule string, onError func()) Store {
	return &fallback{primary: primary, secondary: secondary, log: log, rule: rule, onError: onError}
}

const logEvery = time.Minute

type fallback struct {
	primary, secondary Store
	log                zerolog.Logger
	rule               string
	onError            func()
	lastLog            atomic.Int64
}

func (f *fallback) Allow(id string) (bool, error) {
	ok, err := f.primary.Allow(id)
	if err == nil {
		return ok, nil
	}
	if f.onError != nil {
		f.onError()
	}
	now := time.Now().UnixNano()
	if last := f.lastLog.Load(); now-last >= int64(logEvery) && f.lastLog.CompareAndSwap(last, now) {
		f.log.Warn().Err(err).Str("rule", f.rule).Msg("хранилище пределов недоступно — пределы в памяти реплики")
	}
	return f.secondary.Allow(id)
}

// RedisFactory — пределы в Redis с запасным путём в памяти.
func RedisFactory(client redis.UniversalClient, log zerolog.Logger, onError func(rule string)) Factory {
	return func(r Rule) Store {
		var hook func()
		if onError != nil {
			hook = func() { onError(r.Name) }
		}
		return Fallback(Redis(client, r), Memory(r), log, r.Name, hook)
	}
}

func rateOf(r Rule) rate.Limit {
	return rate.Limit(float64(r.PerPeriod) / r.Period.Seconds())
}
