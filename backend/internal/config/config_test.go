package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// clearEnv убирает переменные, которые могли прийти из окружения
// разработчика: тест проверяет умолчания, а не чужой .env.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"EB_ENV", "EB_DB_DSN", "DATABASE_URL", "EB_API_TOKEN", "EB_CORE_TOKEN",
		"EB_CORE_URL", "PORT", "LLM_BASE_URL", "LLM_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_KEY",
		"EB_DISABLE_THINKING", "EB_LIMIT_CHAT_PER_MINUTE", "EB_SHUTDOWN_TIMEOUT", "EB_METRICS_PORT",
		"EB_LOG_FORMAT", "EB_LOG_LEVEL", "EB_REDIS_URL", "REDIS_URL", "EB_SSE_HEARTBEAT", "EB_ADMIN_TOKEN",
		"EB_LIMIT_SETTINGS_PER_MINUTE", "EB_LIMIT_SETTINGS_BURST"} {
		t.Setenv(k, "")
		require.NoError(t, os.Unsetenv(k))
	}
}

func TestLoadFromEnvOnly(t *testing.T) {
	clearEnv(t)
	t.Setenv("DATABASE_URL", "postgres://railway")
	t.Setenv("PORT", "9999")
	t.Setenv("OPENAI_API_KEY", "k")
	t.Setenv("EB_DISABLE_THINKING", "0")

	cfg, err := Load(filepath.Join(t.TempDir(), "нет-файла.yaml"))
	require.NoError(t, err)
	assert.Equal(t, "postgres://railway", cfg.DB.DSN, "DATABASE_URL Railway подхватывается без переименования")
	assert.Equal(t, 9999, cfg.HTTP.Port, "PORT хостинга главнее своего")
	assert.Equal(t, "k", cfg.LLM.APIKey)
	assert.False(t, cfg.LLM.DisableThinking, "0 из .env ядра выключает, как в Python")
	assert.True(t, cfg.DB.Migrate)
	assert.Equal(t, 3*time.Minute, cfg.Core.Timeout)
	assert.Equal(t, 20, cfg.Limits.ChatPerMinute)
	assert.Equal(t, 10, cfg.Limits.SettingsPerMinute)
	assert.Empty(t, cfg.HTTP.AdminToken, "без токена глобальные настройки закрыты")
	assert.Equal(t, 3*time.Minute+15*time.Second, cfg.ShutdownBudget(), "остановка ждёт не меньше ответа ядра")
	assert.Equal(t, 15*time.Second, cfg.HTTP.SSEHeartbeat)
	assert.Equal(t, 9091, cfg.Metrics.Port)
	assert.Equal(t, "json", cfg.LogFormat(), "в бою — JSON")
}

func TestRedisURLFromRailway(t *testing.T) {
	clearEnv(t)
	t.Setenv("REDIS_URL", "redis://railway:6379")
	cfg, err := Load("нет-файла.yaml")
	require.NoError(t, err)
	assert.Equal(t, "redis://railway:6379", cfg.Limits.RedisURL)
}

func TestVerifyAnyEnv(t *testing.T) {
	clearEnv(t)
	t.Setenv("EB_ENV", "development")
	cfg, err := Load("нет-файла.yaml")
	require.NoError(t, err)
	assert.Equal(t, "console", cfg.LogFormat(), "на машине разработчика — текст")

	cfg.HTTP.ShutdownTimeout = 30 * time.Second
	assert.ErrorContains(t, cfg.Verify(), "EB_SHUTDOWN_TIMEOUT", "даже в разработке")
	cfg.HTTP.ShutdownTimeout = 0
	cfg.Metrics.Port = cfg.HTTP.Port
	assert.ErrorContains(t, cfg.Verify(), "EB_METRICS_PORT")
}

func TestEnvOverridesFile(t *testing.T) {
	clearEnv(t)
	path := filepath.Join(t.TempDir(), "api.yaml")
	require.NoError(t, os.WriteFile(path, []byte("env: development\ndb:\n  dsn: postgres://file\n"), 0o600))
	t.Setenv("EB_DB_DSN", "postgres://env")
	t.Setenv("EB_LIMIT_CHAT_PER_MINUTE", "0")

	cfg, err := Load(path)
	require.NoError(t, err)
	assert.Equal(t, "postgres://env", cfg.DB.DSN)
	assert.Equal(t, 0, cfg.Limits.ChatPerMinute, "переменная выключает предел")
	assert.False(t, cfg.Production())
	assert.NoError(t, cfg.Verify(), "разработка проверку не проходит — она её пропускает")
}

func TestVerifyProduction(t *testing.T) {
	clearEnv(t)
	cfg, err := Load("нет-файла.yaml")
	require.NoError(t, err)
	assert.True(t, cfg.Production(), "молчание об окружении — это бой")
	err = cfg.Verify()
	require.Error(t, err)
	assert.Contains(t, err.Error(), "EB_API_TOKEN")
	assert.Contains(t, err.Error(), "EB_DB_DSN")

	cfg.DB.DSN, cfg.HTTP.Token, cfg.Core.Token = "postgres://x", "t", "c"
	assert.NoError(t, cfg.Verify())

	cfg.Limits.LeadBurst = 0
	assert.Error(t, cfg.Verify())

	cfg.Limits.LeadBurst = 3
	cfg.Retention.LeadsDays = 0
	assert.ErrorContains(t, cfg.Verify(), "EB_RETENTION", "бессрочное хранение заявок в бою не проходит")
}
