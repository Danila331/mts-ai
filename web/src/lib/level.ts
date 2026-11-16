/**
 * Уровень объяснения (T16): «Проще» или «Технически». Меняется только форма ответа — язык и подача: факты, числа
 * и продукты те же. Уходит на сервер полем level, хранится в сессии и добавляет в промпт режима chat одну строку
 * (energybot/prompts.py, LEVEL_HINT). Новых фактов уровень не приносит.
 *
 * Тот же список — в backend/internal/session/level.go и energybot/prompts.py (LEVELS); совпадение проверяет
 * tests/test_level.py. Чистая логика без React: её проверяет npm test (src/lib/level.test.ts).
 */

export const LEVEL_IDS = ["simple", "technical"] as const;

export type LevelId = (typeof LEVEL_IDS)[number];

export interface LevelInfo {
  /** Подпись переключателя. */
  label: string;
  /** Кнопка под ответом: «Объяснить …». */
  action: string;
  /** Подсказка к переключателю. */
  hint: string;
}

export const LEVELS: Record<LevelId, LevelInfo> = {
  simple: {
    label: "Проще",
    action: "Объяснить проще",
    hint: "Обычными словами, термины — с пояснением. Факты те же.",
  },
  technical: {
    label: "Технически",
    action: "Объяснить технически",
    hint: "Точные термины и пороги, как в базе. Факты те же.",
  },
};

export function isLevel(value: unknown): value is LevelId {
  return typeof value === "string" && (LEVEL_IDS as readonly string[]).includes(value);
}

/** Уровень, которого у ответа не было: для кнопки под ответом. Без уровня предлагаем «проще». */
export function otherLevels(current: string | undefined): LevelId[] {
  if (current === "simple") return ["technical"];
  if (current === "technical") return ["simple"];
  return ["simple", "technical"];
}
