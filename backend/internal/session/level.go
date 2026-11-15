package session

import (
	"strings"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
)

// Level — уровень объяснения (T16): «проще» или «технически». Меняется
// только форма ответа — язык и подача, а не факты: в промпт режима chat
// уходит одна строка (energybot/prompts.py, LEVEL_HINT), остальное та же
// база знаний. Тот же список — в web/src/lib/level.ts и
// energybot/prompts.py (LEVELS); совпадение проверяет tests/test_level.py.
type Level string

const (
	LevelSimple    Level = "simple"    // без терминов, а нужный термин сразу с пояснением
	LevelTechnical Level = "technical" // точные термины и пороги
)

// Levels — все уровни.
var Levels = []Level{LevelSimple, LevelTechnical}

// Known — уровень из списка.
func (l Level) Known() bool {
	for _, k := range Levels {
		if l == k {
			return true
		}
	}
	return false
}

// LevelChoice — уровень вопроса. Chosen — клиент прислал поле level:
// пустое значение тогда значит «обычный уровень» и стирает прежний
// выбор; без поля сессия помнит уровень, выбранный раньше.
type LevelChoice struct {
	Level  Level
	Chosen bool
}

// ParseLevel проверяет поле level запроса. nil — поля не было.
func ParseLevel(level *string) (LevelChoice, error) {
	if level == nil {
		return LevelChoice{}, nil
	}
	l := Level(strings.TrimSpace(*level))
	if l != "" && !l.Known() {
		return LevelChoice{}, apperr.Invalidf("level: simple или technical")
	}
	return LevelChoice{Level: l, Chosen: true}, nil
}
