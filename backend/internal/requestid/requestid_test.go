package requestid

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestValid(t *testing.T) {
	assert.True(t, Valid(New()))
	assert.True(t, Valid("front-42_a.b"))
	for _, bad := range []string{"", "a b", "a\nb", "id\"", strings.Repeat("a", MaxLen+1)} {
		assert.False(t, Valid(bad), bad)
	}
	assert.Equal(t, "x", From(With(context.Background(), "x")))
	assert.Empty(t, From(context.Background()))
}
