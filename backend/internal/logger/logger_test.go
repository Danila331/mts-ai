package logger

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/rs/zerolog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewJSON(t *testing.T) {
	var buf bytes.Buffer
	log, err := New(Options{Level: "WARN", Service: "api", Version: "abc", Out: &buf})
	require.NoError(t, err)

	log.Info().Msg("не видно")
	log.Warn().Str("k", "v").Msg("видно")
	var line map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &line), "одна строка JSON: info отсечён уровнем")
	assert.Equal(t, "api", line["service"])
	assert.Equal(t, "abc", line["version"])
	assert.Equal(t, "warn", line["level"])
	assert.NotEmpty(t, line["time"])

	buf.Reset()
	zerolog.Ctx(context.Background()).Warn().Msg("из контекста без логгера")
	assert.Contains(t, buf.String(), `"service":"api"`, "контекст без логгера пишет в общий журнал")
}

func TestNewRejectsBadOptions(t *testing.T) {
	_, err := New(Options{Level: "loud"})
	assert.Error(t, err)
	_, err = New(Options{Format: "xml"})
	assert.Error(t, err)
	_, err = New(Options{Format: FormatConsole, Out: &bytes.Buffer{}})
	assert.NoError(t, err)
}
