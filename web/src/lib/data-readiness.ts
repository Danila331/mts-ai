/**
 * Проверка готовности выгрузки для поиска коммерческих потерь (T21, сетевые компании).
 *
 * Чистый модуль: без React и без импортов — его напрямую гоняет `node --experimental-strip-types --test`.
 * Файл разбирается только в браузере. Наружу (паспорт клиента, T2) может уйти лишь {@link DataReadiness} —
 * булевы флаги и ключи недостающих требований, без единого значения из файла.
 *
 * Никакого поиска потерь, скоринга абонентов или «вероятных хищений»: это продукт МТС, а не стенд.
 * Здесь проверяется только, хватает ли в выгрузке сведений, перечисленных в базе знаний.
 *
 * Ограничение №1: всё, что решает логика (что обязательно, что «желательно», порог глубины архива),
 * взято из раздела базы {@link KB_SECTION}. Цитаты {@link KB_QUOTES} сверяет с текстом базы тест
 * `data-readiness.test.ts` — поменяется база, упадёт тест.
 */

// ---------- опора на базу знаний ----------

export const KB_DOC = "00-reference/03-calculation-and-requests.md";
export const KB_SECTION = "Для поиска коммерческих потерь";

/** Дословные формулировки раздела, на которых держится каждая проверка. Показываются на экране как основание. */
export const KB_QUOTES = {
  anonymized: "обезличенная выгрузка данных учёта",
  channelId: "идентификатор канала учёта",
  datesAndReadings: "даты и значения показаний",
  dailyDayNight: "суточное потребление с разбивкой на дневное и ночное",
  minimum: "Минимально достаточно суточных данных с разбивкой на день и ночь.",
  intervals: "Часовые или получасовые интервалы желательны.",
  archive: "глубина архива не менее одного года",
  passport: "адрес установки прибора, серийный номер и категория абонента",
} as const;

const DAY_MS = 86_400_000;

/**
 * «Не менее одного года» из {@link KB_QUOTES.archive}. Год считаем как 365 календарных дней включительно:
 * суточный архив с 01.01 по 31.12 обычного года — это ровно 365 дат, и он должен проходить. Високосный год
 * (366 дат) проходит с запасом, а архив «с 1 марта по 28 февраля» через високосный февраль (365 дат) — тоже:
 * это допуск в один день на границах, чтобы не отбраковывать полный год из-за 29 февраля.
 */
export const ARCHIVE_MIN_DAYS = 365;

/** «Часовые или получасовые» из {@link KB_QUOTES.intervals}: шаг не длиннее часа. */
export const INTERVAL_MAX_MINUTES = 60;

// ---------- требования и итог ----------

/** Требования раздела базы. `intervals` — «желательно» и не блокирует итог. */
export const REQUIREMENTS = [
  "channelId",
  "dates",
  "readings",
  "dailyDayNight",
  "archiveYear",
  "address",
  "serial",
  "category",
  "intervals",
] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

export const OPTIONAL_REQUIREMENTS: readonly Requirement[] = ["intervals"];

export type ReadinessFlags = Record<Requirement, boolean>;

/**
 * Итог проверки — единственное, что можно передавать дальше (паспорт клиента, T2). Только флаги и ключи
 * требований: ни строк, ни значений, ни названий колонок из файла.
 */
export interface DataReadiness {
  ready: boolean;
  /** Ключи обязательных требований, которых не хватает, в порядке {@link REQUIREMENTS}. */
  missing: Requirement[];
  flags: ReadinessFlags;
}

/** Подписи требований для экрана: «Не хватает: …». */
export const REQUIREMENT_LABELS: Record<Requirement, string> = {
  channelId: "идентификатор канала учёта",
  dates: "даты показаний",
  readings: "значения показаний",
  dailyDayNight: "суточное потребление с разбивкой на день и ночь",
  archiveYear: "архив не менее одного года",
  address: "адрес установки прибора",
  serial: "серийный номер прибора",
  category: "категория абонента",
  intervals: "часовые или получасовые интервалы",
};

/** Цитата базы — основание для каждого требования. */
export const REQUIREMENT_QUOTES: Record<Requirement, string> = {
  channelId: KB_QUOTES.channelId,
  dates: KB_QUOTES.datesAndReadings,
  readings: KB_QUOTES.datesAndReadings,
  dailyDayNight: KB_QUOTES.minimum,
  archiveYear: KB_QUOTES.archive,
  address: KB_QUOTES.passport,
  serial: KB_QUOTES.passport,
  category: KB_QUOTES.passport,
  intervals: KB_QUOTES.intervals,
};

// ---------- колонки ----------

export const ROLES = ["channel", "date", "time", "reading", "day", "night", "address", "serial", "category"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  channel: "Идентификатор канала учёта",
  date: "Дата показания",
  time: "Время или интервал",
  reading: "Значение показания",
  day: "Потребление днём",
  night: "Потребление ночью",
  address: "Адрес установки",
  serial: "Серийный номер",
  category: "Категория абонента",
};

/** Роль → номер колонки. Роли без колонки в объекте нет. */
export type Mapping = Partial<Record<Role, number>>;

/**
 * Синонимы названий колонок. Название режется на слова (буквы и цифры), синоним совпадает, если какое-то слово
 * с него начинается («серийн» → «Серийный»), а синоним из нескольких слов — если они идут подряд.
 * Порядок ролей важен: «Серийный номер (ID прибора)» — серийный номер, а не идентификатор канала;
 * «День (T1), кВт·ч» — дневная зона, а не значение показания.
 */
const SYNONYMS: [Role, string[]][] = [
  ["serial", ["серийн", "serial", "заводск", "зав", "sn"]],
  ["category", ["категор", "category", "тип абонент", "тип потребит"]],
  ["address", ["адрес", "address", "улиц", "street"]],
  ["night", ["ноч", "night", "t2", "т2"]],
  ["day", ["день", "днев", "днем", "day", "t1", "т1"]],
  ["channel", ["канал", "channel", "идентификатор", "ид", "id", "точка учет", "point"]],
  ["date", ["дат", "date", "timestamp", "period", "период"]],
  ["time", ["время", "time", "час", "интервал", "interval", "hour"]],
  ["reading", ["показан", "значен", "reading", "value", "потребл", "расход", "consumption", "квт", "kwh", "энерг", "energy"]],
];

function words(header: string): string[] {
  return header
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function matches(tokens: string[], synonym: string): boolean {
  const parts = synonym.replace(/ё/g, "е").split(" ");
  for (let i = 0; i + parts.length <= tokens.length; i++) {
    const head = parts.slice(0, -1).every((p, k) => tokens[i + k] === p);
    if (head && tokens[i + parts.length - 1].startsWith(parts[parts.length - 1])) return true;
  }
  return false;
}

/** Роль, которую название колонки подсказывает само по себе, без учёта соседних колонок. */
export function guessRole(header: string): Role | undefined {
  const tokens = words(header);
  return SYNONYMS.find(([, list]) => list.some((s) => matches(tokens, s)))?.[0];
}

/** Автоматическое сопоставление: каждой роли — первая подходящая колонка, каждая колонка — не больше одной роли. */
export function autoMap(headers: string[]): Mapping {
  const mapping: Mapping = {};
  const used = new Set<number>();
  const tokens = headers.map(words);
  for (const [role, list] of SYNONYMS) {
    const index = tokens.findIndex((t, i) => !used.has(i) && list.some((s) => matches(t, s)));
    if (index >= 0) {
      mapping[role] = index;
      used.add(index);
    }
  }
  return mapping;
}

/** Ручная правка: колонка уходит выбранной роли и снимается с роли, у которой была. */
export function assignColumn(mapping: Mapping, role: Role, column: number | undefined): Mapping {
  const next: Mapping = {};
  for (const r of ROLES) if (r !== role && mapping[r] !== undefined && mapping[r] !== column) next[r] = mapping[r];
  if (column !== undefined) next[role] = column;
  return next;
}

// ---------- CSV ----------

export type Delimiter = ";" | "," | "\t";

export interface Table {
  headers: string[];
  rows: string[][];
  delimiter: Delimiter;
}

/** UTF-8, а если байты в нём невалидны — Windows-1251: так сохраняет CSV русский Excel. */
export function decodeBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1251").decode(bytes);
  }
}

/** XLSX и другие ZIP-контейнеры начинаются с «PK». */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Разделитель по первой строке: какого из `;`, `,` и табуляции больше вне кавычек. При равенстве — `;`. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ";": 0, ",": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch as Delimiter]++;
  }
  const best = (Object.keys(counts) as Delimiter[]).reduce((a, b) => (counts[b] > counts[a] ? b : a), ";");
  return counts[best] > 0 ? best : ";";
}

/** Разбор CSV по RFC 4180: кавычки, `""` внутри кавычек, переводы строк внутри ячейки, CRLF, BOM. */
export function parseCsv(input: string, delimiter?: Delimiter): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Таблица с заголовками. Ошибка — текстом для экрана. */
export function readTable(input: string): Table {
  let text = input.replace(/^\uFEFF/, "");
  // Подсказка Excel «sep=;» первой строкой.
  const hint = /^sep=([;,\t])\r?\n/i.exec(text);
  if (hint) text = text.slice(hint[0].length);
  const delimiter = hint ? (hint[1] as Delimiter) : detectDelimiter(text);
  const all = parseCsv(text, delimiter);
  if (!all.length) throw new Error("Файл пустой: в нём нет ни одной строки.");
  const [head, ...rows] = all;
  if (head.length < 2) {
    throw new Error("Не удалось разделить строки на колонки. Нужен CSV с разделителем «;» или «,».");
  }
  if (!rows.length) throw new Error("В файле только строка заголовков — нет ни одной строки данных.");
  const headers = head.map((h, i) => h.trim() || `Колонка ${i + 1}`);
  return { headers, rows, delimiter };
}

// ---------- значения ----------

/** Число из ячейки: «1 234,5», «1234.5», неразрывные пробелы. Пустое или нечисловое — null. */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.replace(/[\s\u00A0\u202F']/g, "");
  if (!s) return null;
  s = s.includes(".") && s.includes(",") ? s.replace(/,/g, "") : s.replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const RU_DATE = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const ISO_DATE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const TIME = /^(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?/;

function utc(y: number, m: number, d: number, h = 0, min = 0): number | null {
  const day = Date.UTC(y, m - 1, d);
  const check = new Date(day);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  // 24:00 встречается в выгрузках счётчиков как конец суток.
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return day + (h * 60 + min) * 60_000;
}

/**
 * Дата `ДД.ММ.ГГГГ` (или `ДД/ММ/ГГГГ`) либо ISO `ГГГГ-ММ-ДД`, с временем или без. Возвращает миллисекунды UTC
 * «как написано» — часовой пояс не учитываем: важны только шаг и глубина архива.
 */
export function parseDate(raw: string | undefined): number | null {
  const s = raw?.trim();
  if (!s) return null;
  let m = RU_DATE.exec(s);
  if (m) return utc(+m[3], +m[2], +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  m = ISO_DATE.exec(s);
  if (m) return utc(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  return null;
}

/** Смещение от начала суток в минутах: «13:30», «13:30-14:00» (берём начало), номер часа «0»…«24». */
export function parseTime(raw: string | undefined): number | null {
  const s = raw?.trim();
  if (!s) return null;
  const m = TIME.exec(s);
  if (m) {
    const h = +m[1];
    const min = +m[2];
    return h <= 24 && min <= 59 ? h * 60 + min : null;
  }
  if (/^\d{1,2}$/.test(s) && +s <= 24) return +s * 60;
  return null;
}

// ---------- проверка ----------

export interface Analysis {
  readiness: DataReadiness;
  /** Строк данных без заголовка. */
  rows: number;
  /** Строк с датой, которую не удалось разобрать (при сопоставленной колонке даты). */
  badDates: number;
  /** Первая и последняя дата архива, `ГГГГ-ММ-ДД`. */
  from?: string;
  to?: string;
  /** Сколько календарных дней покрывает архив, включительно. */
  archiveDays: number;
  /** Самый частый шаг между показаниями одного канала, в минутах. */
  stepMinutes?: number;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function analyze(table: Table, mapping: Mapping): Analysis {
  const col = (role: Role) => mapping[role];
  const cell = (row: string[], role: Role) => {
    const i = col(role);
    return i === undefined ? undefined : row[i];
  };
  const filled = (role: Role) => col(role) !== undefined && table.rows.some((r) => (cell(r, role) ?? "").trim() !== "");
  const numeric = (role: Role) => col(role) !== undefined && table.rows.some((r) => parseNumber(cell(r, role)) !== null);

  let first = Infinity;
  let last = -Infinity;
  let badDates = 0;
  let datedRows = 0;
  const series = new Map<string, number[]>();
  if (col("date") !== undefined) {
    for (const row of table.rows) {
      const raw = cell(row, "date");
      const date = parseDate(raw);
      if (date === null) {
        if ((raw ?? "").trim()) badDates++;
        continue;
      }
      datedRows++;
      const day = Math.floor(date / DAY_MS) * DAY_MS;
      first = Math.min(first, day);
      last = Math.max(last, day);
      const time = parseTime(cell(row, "time"));
      const at = time === null ? date : day + time * 60_000;
      const key = cell(row, "channel")?.trim() ?? "";
      const list = series.get(key);
      if (list) list.push(at);
      else series.set(key, [at]);
    }
  }
  const archiveDays = datedRows ? Math.round((last - first) / DAY_MS) + 1 : 0;

  // Шаг показаний: самый частый промежуток между соседними отметками времени одного канала.
  const steps = new Map<number, number>();
  for (const list of series.values()) {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const step = Math.round((sorted[i] - sorted[i - 1]) / 60_000);
      steps.set(step, (steps.get(step) ?? 0) + 1);
    }
  }
  let stepMinutes: number | undefined;
  for (const [step, count] of steps) if (stepMinutes === undefined || count > steps.get(stepMinutes)!) stepMinutes = step;

  const dailyDayNight = numeric("day") && numeric("night");
  const flags: ReadinessFlags = {
    channelId: filled("channel"),
    dates: datedRows > 0,
    // «Значения показаний» — колонка показаний или, по минимуму из базы, суточные значения день/ночь.
    readings: numeric("reading") || dailyDayNight,
    dailyDayNight,
    archiveYear: archiveDays >= ARCHIVE_MIN_DAYS,
    address: filled("address"),
    serial: filled("serial"),
    category: filled("category"),
    intervals: stepMinutes !== undefined && stepMinutes > 0 && stepMinutes <= INTERVAL_MAX_MINUTES,
  };
  const missing = REQUIREMENTS.filter((r) => !OPTIONAL_REQUIREMENTS.includes(r) && !flags[r]);
  return {
    readiness: { ready: missing.length === 0, missing, flags },
    rows: table.rows.length,
    badDates,
    from: datedRows ? isoDay(first) : undefined,
    to: datedRows ? isoDay(last) : undefined,
    archiveDays,
    stepMinutes,
  };
}

/** Всё сразу: текст CSV → итог с автоматическим сопоставлением колонок. */
export function checkCsv(text: string): Analysis & { table: Table; mapping: Mapping } {
  const table = readTable(text);
  const mapping = autoMap(table.headers);
  return { ...analyze(table, mapping), table, mapping };
}

// ---------- ссылка на раздел базы ----------

interface KbDocLike {
  doc: string;
  chunks: { id: string; path: string }[];
}

/**
 * Ссылка на раздел «Для поиска коммерческих потерь» в /kb. id раздела — sha1 от текста (`energybot/kb.py`),
 * поэтому не зашиваем его, а находим в ответе `GET /api/kb`. Пока база не загрузилась — ссылка на документ.
 */
export function kbSectionHref(docs?: readonly KbDocLike[] | null): string {
  const name = KB_DOC.split("/").pop()!;
  const doc = docs?.find((d) => d.doc === KB_DOC || d.doc.split("/").pop() === name);
  const chunk = doc?.chunks.find((c) => c.path.split(" > ").pop()?.trim() === KB_SECTION);
  if (chunk) return `/kb?chunk=${encodeURIComponent(chunk.id)}`;
  return `/kb?doc=${encodeURIComponent(doc?.doc ?? KB_DOC)}`;
}
