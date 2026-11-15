package ratelimit

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var rule = Rule{Name: "chat", PerPeriod: 2, Period: time.Minute, Burst: 2}

func allowN(t *testing.T, s Store, id string, n int) (allowed int) {
	t.Helper()
	for i := 0; i < n; i++ {
		ok, err := s.Allow(id)
		require.NoError(t, err)
		if ok {
			allowed++
		}
	}
	return allowed
}

func TestRedisSharedAcrossReplicas(t *testing.T) {
	mr := miniredis.RunT(t)
	// Две реплики — два клиента к одному Redis.
	a := Redis(redis.NewClient(&redis.Options{Addr: mr.Addr()}), rule)
	b := Redis(redis.NewClient(&redis.Options{Addr: mr.Addr()}), rule)

	assert.Equal(t, 2, allowN(t, a, "1.1.1.1", 1)+allowN(t, b, "1.1.1.1", 1))
	assert.Equal(t, 0, allowN(t, a, "1.1.1.1", 1)+allowN(t, b, "1.1.1.1", 1),
		"предел общий: вторая реплика не даёт второй запас")
	assert.Equal(t, 2, allowN(t, b, "2.2.2.2", 3), "предел — на адрес")
}

func TestFallbackToMemoryWhenRedisDown(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr(), MaxRetries: -1})
	errs := 0
	s := RedisFactory(client, zerolog.Nop(), func(string) { errs++ })(rule)
	mr.Close()

	assert.Equal(t, 2, allowN(t, s, "1.1.1.1", 3), "Redis лёг — предел в памяти, а не отказ всем")
	assert.Equal(t, 3, errs, "каждый сбой посчитан")
}

func TestMemory(t *testing.T) {
	s := Memory(rule)
	assert.Equal(t, 2, allowN(t, s, "x", 5))
}
