/**
 * Глоссарий подсказок к терминам (T16): подчёркнутый в ответе бота термин — по наведению или касанию определение
 * и ссылка на раздел базы знаний.
 *
 * Определения берутся только из `knowledge-base/` — дословными фрагментами раздела, на который ссылается запись;
 * ни одного слова «от себя». Это проверяет `glossary.test.ts`: каждое определение найдено в тексте своего раздела,
 * поменяется база — упадёт тест. Если термина в базе нет (ОРЭМ, ИСУ), записи для него нет и подсказки тоже.
 *
 * Чистый модуль: только type-импорты и чистая функция ссылки, без React и сети — его гоняет
 * `node --experimental-strip-types --test`. id раздела не зашит: он зависит от текста (sha1, `energybot/kb.py`),
 * поэтому ссылку собирает {@link glossaryHref} по ответу `GET /api/kb`.
 */
import { type KbLike, kbSectionHref } from "./consultation-summary.ts";

export interface GlossaryEntry {
  id: string;
  /** Заголовок подсказки. */
  term: string;
  /** Как термин встречается в тексте: регулярное выражение с флагом `iu`. Границы слов — через \p{L}. */
  pattern: string;
  /** Дословный фрагмент раздела базы (пробелы и переводы строк — в один пробел, разметка `**` убрана). */
  definition: string;
  /** Документ базы и последний заголовок раздела, где этот фрагмент стоит. */
  doc: string;
  section: string;
}

const FAQ = "10-energy/17-faq.md";

/** Слева и справа от термина — не буква и не цифра: JS-шное \b кириллицу не знает. */
const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    id: "kwh",
    term: "Киловатт-час (кВт·ч)",
    pattern: `${L}(?:киловатт-час\\p{L}*|кВт[·⋅*-]?ч)${R}`,
    definition: "Энергия это то, сколько вы потребили, она измеряется в киловатт-часах и видна как объём в счёте.",
    doc: FAQ,
    section: "Чем мощность отличается от энергии",
  },
  {
    id: "kw",
    term: "Киловатт (кВт)",
    pattern: `${L}(?:кВт|киловатт\\p{L}*)(?![\\p{L}\\p{N}·⋅*-])`,
    definition: "Мощность это то, сколько вы способны потреблять одновременно, она измеряется в киловаттах.",
    doc: FAQ,
    section: "Чем мощность отличается от энергии",
  },
  {
    id: "connected-power",
    term: "Присоединённая мощность",
    pattern: `${L}присоединённ\\p{L}*\\s+(?:\\(максимальн\\p{L}*\\)\\s+)?мощност\\p{L}*`,
    definition: "Это мощность, на которую вы официально присоединены к сети.",
    doc: FAQ,
    section: "Что такое присоединённая мощность и где она написана",
  },
  {
    id: "price-category",
    term: "Ценовая категория",
    pattern: `${L}ценов\\p{L}*\\s+категори\\p{L}*`,
    definition: "Это способ, которым вам считают счёт на розничном рынке. Категорий шесть.",
    doc: "10-energy/11-price-categories.md",
    section: "Что такое ценовая категория",
  },
  {
    id: "askue",
    term: "АСКУЭ",
    pattern: `${L}АСКУЭ${R}`,
    definition: "Учёт: интервальный почасовой, то есть АСКУЭ.",
    doc: "10-energy/11-price-categories.md",
    section: "Шесть категорий",
  },
  {
    id: "interval-metering",
    term: "Интервальный почасовой учёт",
    pattern: `${L}(?:интервальн\\p{L}*\\s+почасов\\p{L}*|почасов\\p{L}*\\s+интервальн\\p{L}*)\\s+учёт\\p{L}*`,
    definition: "Почасовой интервальный учёт обязателен для потребителей с присоединённой мощностью от 670 кВт.",
    doc: "10-energy/13-metering.md",
    section: "Виды учёта",
  },
  {
    id: "retail-market",
    term: "Розничный рынок",
    pattern: `${L}розничн\\p{L}*\\s+рын\\p{L}*`,
    definition:
      "Розничный рынок это то, где находится подавляющее большинство предприятий: договор с поставщиком, расчёт по ценовой категории, цена формируется поставщиком по установленным правилам.",
    doc: "10-energy/10-market.md",
    section: "Розница и опт",
  },
  {
    id: "wholesale-market",
    term: "Оптовый рынок",
    pattern: `${L}оптов\\p{L}*\\s+рын\\p{L}*`,
    definition: "Оптовый рынок это площадка, где электроэнергия покупается напрямую.",
    doc: "10-energy/10-market.md",
    section: "Розница и опт",
  },
  {
    id: "reactive",
    term: "Реактивная энергия",
    pattern: `${L}реактивн\\p{L}*\\s+энерги\\p{L}*`,
    definition:
      "Часть оборудования (двигатели, трансформаторы, сварка) потребляет не только полезную активную энергию, но и реактивную, которая нагружает сеть, не совершая работы.",
    doc: FAQ,
    section: "Что такое реактивная энергия и почему за неё берут деньги",
  },
  {
    id: "imbalance",
    term: "Небаланс",
    pattern: `${L}небаланс\\p{L}*`,
    definition:
      "Расхождение между тем, сколько энергии поступило на объект или в сеть, и тем, сколько учтено по приборам.",
    doc: FAQ,
    section: "Что такое небаланс",
  },
  {
    id: "gtp",
    term: "ГТП",
    pattern: `${L}ГТП${R}`,
    definition: "Группа точек поставки: совокупность точек, по которым ведутся расчёты на оптовом рынке.",
    doc: FAQ,
    section: "Что такое ГТП",
  },
];

export interface Piece {
  text: string;
  /** Есть — это термин глоссария: его надо подчеркнуть. */
  entry?: GlossaryEntry;
}

const REGEXPS = new Map(GLOSSARY.map((e) => [e.id, new RegExp(e.pattern, "iu")] as const));

/**
 * Разбивает текст на куски: обычный текст и термины. Каждый термин размечается один раз за ответ — в `seen`
 * копятся уже размеченные id, его передают во все предложения ответа. Пересекающиеся совпадения: остаётся то,
 * что левее, а при равенстве — длиннее («присоединённая мощность» важнее «мощность»).
 */
export function markTerms(text: string, seen: Set<string> = new Set()): Piece[] {
  const found: { start: number; end: number; entry: GlossaryEntry }[] = [];
  for (const entry of GLOSSARY) {
    if (seen.has(entry.id)) continue;
    const m = REGEXPS.get(entry.id)!.exec(text);
    if (m) found.push({ start: m.index, end: m.index + m[0].length, entry });
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const taken: typeof found = [];
  for (const f of found) if (!taken.length || f.start >= taken[taken.length - 1].end) taken.push(f);

  const pieces: Piece[] = [];
  let at = 0;
  for (const f of taken) {
    if (f.start > at) pieces.push({ text: text.slice(at, f.start) });
    pieces.push({ text: text.slice(f.start, f.end), entry: f.entry });
    seen.add(f.entry.id);
    at = f.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces.length ? pieces : [{ text }];
}

/** Ссылка «в базе»: `/kb?chunk=<id раздела>`; пока база не загрузилась — на документ. */
export function glossaryHref(entry: GlossaryEntry, kb?: KbLike | null): string {
  return kbSectionHref(kb, entry.doc, entry.section);
}
