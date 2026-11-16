/**
 * Потоковая выдача ответа (T13): дельты ядра печатаются, пока идёт генерация, а финальное событие answer
 * главнее напечатанного — проверка ответа (guard) работает после генерации и может переписать или вырезать
 * предложение. Тогда текст заменяется, а у ответа появляется метка «Уточнено проверкой».
 *
 * Чистый модуль без импортов: его тестирует `node --test` без сборки (npm test).
 */

/**
 * Печатаемый текст в том же виде, что финальный: ядро чистит ответ функцией tidy() (energybot/pipeline.py) —
 * без markdown, маркеров списка и переносов. Иначе текст «прыгнул» бы при замене на answer.
 */
export function tidyStream(text: string): string {
  return text
    .trim()
    .replace(/^\s*(?:Консультант|Ассистент)\s*:\s*/i, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Дописывает дельту к накопленному тексту; всё, что не строка, — пропускается. */
export function appendDelta(acc: string, delta: unknown): string {
  const text = (delta as { text?: unknown } | null)?.text;
  return typeof text === "string" ? acc + text : acc;
}

/**
 * Отличается ли финальный ответ от напечатанного. Ядро само говорит об этом полем revised (сравнивает после
 * той же чистки); без него — сравниваем здесь. Ничего не напечатано — метки нет: ответ пришёл целиком.
 */
export function isRevised(streamed: string, answer: { text: string; revised?: boolean }): boolean {
  if (!streamed.trim()) return false;
  if (typeof answer.revised === "boolean") return answer.revised;
  return tidyStream(streamed) !== tidyStream(answer.text);
}

/**
 * Атрибут виджета data-stream и параметр /embed?stream=: "0", "false", "off", "no" — потоковая выдача выключена,
 * "1", "true", "on", "yes" — включена. Остальное — не задано (undefined): решает умолчание (включена).
 */
export function parseStreamFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(v)) return false;
  if (["1", "true", "on", "yes"].includes(v)) return true;
  return undefined;
}
