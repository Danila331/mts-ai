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
		"EB_DISABLE_THINKING", "EB_LIMIT_CHAT_PER_MINUTE"} {
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
}
