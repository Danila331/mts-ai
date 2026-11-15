package privacy

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewSubject(t *testing.T) {
	for _, phone := range []string{"+7 (900) 123-45-67", "8 900 123 45 67", "9001234567"} {
		s, err := NewSubject(phone, "")
		require.NoError(t, err, phone)
		assert.Equal(t, "9001234567", s.Phone10, "один номер в любой записи: %s", phone)
	}
	_, err := NewSubject("123-45", "")
	assert.Error(t, err, "короткий номер совпал бы с чужими цифрами")
	_, err = NewSubject("", "")
	assert.Error(t, err)
	s, err := NewSubject("", "3f9a1c07b2")
	require.NoError(t, err)
	assert.Equal(t, "3f9a1c07b2", s.LeadCode)
}

func TestCutoffs(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	c := Policy{Leads: 48 * time.Hour, Answers: 0}.Cutoffs(now)
	assert.Equal(t, now.Add(-48*time.Hour), c.Leads)
	assert.True(t, c.Answers.IsZero(), "ноль — без срока, таблица не чистится")
}
