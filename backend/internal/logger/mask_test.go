package logger

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMaskString(t *testing.T) {
	for in, want := range map[string]string{
		"позвонить +7 (900) 123-45-67 завтра":     "позвонить *** завтра",
		"телефон 89001234567":                     "телефон ***",
		"тел. 8-900-123-45-67.":                   "тел. ***.",
		"почта ivan.petrov@example.com, да":       "почта ***, да",
		"ошибка: pq: duplicate (a@b.ru)":          "ошибка: pq: duplicate (***)",
		"время 2026-11-16T12:30:45.123Z":          "время 2026-11-16T12:30:45.123Z",
		`"took":1532.4,"status":200`:              `"took":1532.4,"status":200`,
		"request_id 3f9a2b7c4d5e6f708192a3b4c5d6": "request_id 3f9a2b7c4d5e6f708192a3b4c5d6",
		"id a1234567890b и 1234567890c":           "id a1234567890b и 1234567890c",
		"1234567890123456789 — id":                "1234567890123456789 — id",
	} {
		assert.Equal(t, want, MaskString(in), in)
	}
}

func TestRememberMasksNames(t *testing.T) {
	t.Cleanup(forget)
	Remember("Иван Петров", "ООО Ромашка", "ия", "")
	got := MaskString("не удалось записать заявку Иван Петров из ООО Ромашка, ия")
	assert.Equal(t, "не удалось записать заявку *** из ***, ия", got, "короткие значения не запоминаются")
}

func TestMaskWriterInLogger(t *testing.T) {
	t.Cleanup(forget)
	Remember("Тестов Тест")
	var buf bytes.Buffer
	log, err := New(Options{Out: &buf})
	require.NoError(t, err)

	log.Error().Str("err", "ошибка для Тестов Тест, +7 900 000-00-00, test@example.com").Msg("заявка")
	line := buf.String()
	assert.NotContains(t, line, "Тестов")
	assert.NotContains(t, line, "000-00-00")
	assert.NotContains(t, line, "example.com")
	assert.Contains(t, line, `"message":"заявка"`)
	assert.Contains(t, line, "***")
}
