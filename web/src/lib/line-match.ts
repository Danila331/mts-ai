/**
 * Какая строка раздела базы стоит за предложением ответа. Без React и DOM — чистая функция.
 * Тот же приём, что в ядре (scripts/core_api.py → attribute): пересечение основ слов + совпадение чисел.
 * Строки считаются так же, как их рисует ChunkText: непустые строки текста раздела подряд.
 * Таблицы pandoc в базе записаны строками «колонка: значение; колонка: значение» — строка таблицы это одна строка.
 */

export const STEM_LEN = 5;
const NUMBER_WEIGHT = 0.35;
const MIN_OVERLAP = 0.25;
const MIN_OVERLAP_WITH_NUMBER = 0.1;

export interface LineMatch {
  /** Индекс среди непустых строк раздела. */
  line: number;
  score: number;
  overlap: number;
  numbers: string[];
}

/** Непустые строки раздела — те самые, что нумерует ChunkText. */
export function textLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim());
}

/** Основы слов: нижний регистр, ё→е, первые 5 букв; короткие слова (меньше 4 букв) — шум. */
export function stems(text: string): Set<string> {
  const out = new Set<string>();
  const words = text.toLowerCase().replace(/ё/g, "е").match(/[a-zа-я]{4,}/g) ?? [];
  for (const w of words) out.add(w.slice(0, STEM_LEN));
  return out;
}

/** Числа без пробелов-разделителей тысяч и с точкой вместо запятой; «1 и 2» как в ядре отбрасываем. */
export function numbersIn(text: string): Set<string> {
  const flat = text.replace(/(\d)[\s ](?=\d{3}\b)/g, "$1");
  const out = new Set<string>();
  for (const m of flat.match(/\d+(?:[.,]\d+)?/g) ?? []) {
    const n = m.replace(",", ".");
    if (/^\d+$/.test(n) && Number(n) <= 2) continue;
    out.add(n);
  }
  return out;
}

/** Лучшая строка раздела для предложения ответа; null, если совпадение слабое (подсветим раздел целиком). */
export function bestLine(sentence: string, chunkText: string): LineMatch | null {
  const words = stems(sentence);
  const nums = numbersIn(sentence);
  if (!words.size && !nums.size) return null;
  let best: LineMatch | null = null;
  let bestLen = 0;
  const lines = textLines(chunkText);
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line];
    const vocab = stems(raw);
    const hit = words.size ? [...words].filter((w) => vocab.has(w)).length / words.size : 0;
    const have = numbersIn(raw);
    const numbers = [...nums].filter((n) => have.has(n)).sort();
    if (hit < MIN_OVERLAP && !(numbers.length && hit >= MIN_OVERLAP_WITH_NUMBER)) continue;
    const score = hit + NUMBER_WEIGHT * numbers.length;
    // при равенстве лучше короткая строка: она точнее указывает место
    const better = !best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && raw.length < bestLen);
    if (better) {
      best = { line, score, overlap: hit, numbers };
      bestLen = raw.length;
    }
  }
  return best;
}

/** Строка раздела id, на которую лучше всего опирается любое из предложений ответа, где он назван в опоре. */
export function bestCitationLine(
  citations: { sentence: string; question?: boolean; support: { id: string }[] }[],
  id: string,
  chunkText: string,
): (LineMatch & { sentence: string }) | null {
  let best: (LineMatch & { sentence: string }) | null = null;
  for (const c of citations) {
    if (c.question || !c.support.some((s) => s.id === id)) continue;
    const m = bestLine(c.sentence, chunkText);
    if (m && (!best || m.score > best.score)) best = { ...m, sentence: c.sentence };
  }
  return best;
}

/** Параметр ссылки hl: только индекс строки, без текста ответа и без ПДн. */
export function parseHl(value: string | null | undefined): number | undefined {
  if (value == null || !/^\d{1,4}$/.test(value)) return undefined;
  return Number(value);
}
