package session

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
)

func TestParseLevel(t *testing.T) {
	str := func(s string) *string { return &s }
	for _, c := range []struct {
		in   *string
		want LevelChoice
	}{
		{nil, LevelChoice{}},
		{str(""), LevelChoice{Chosen: true}},
		{str("simple"), LevelChoice{Level: LevelSimple, Chosen: true}},
		{str(" technical "), LevelChoice{Level: LevelTechnical, Chosen: true}},
	} {
		got, err := ParseLevel(c.in)
		require.NoError(t, err)
		assert.Equal(t, c.want, got)
	}
	for _, bad := range []string{"expert", "Simple", "easy"} {
		_, err := ParseLevel(&bad)
		inv, ok := apperr.AsInvalid(err)
		require.True(t, ok, bad)
		assert.Equal(t, "level: simple или technical", inv.Msg)
	}
}
