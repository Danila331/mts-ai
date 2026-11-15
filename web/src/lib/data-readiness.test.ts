// node --experimental-strip-types --test src/lib/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  ARCHIVE_MIN_DAYS,
  INTERVAL_MAX_MINUTES,
  KB_DOC,
  KB_QUOTES,
  KB_SECTION,
  REQUIREMENT_LABELS,
  REQUIREMENT_QUOTES,
  analyze,
  assignColumn,
  autoMap,
  checkCsv,
  decodeBytes,
  detectDelimiter,
  guessRole,
  kbSectionHref,
  looksLikeZip,
  parseCsv,
  parseDate,
  parseNumber,
  parseTime,
  readTable,
} from "./data-readiness.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/readiness/${name}`, import.meta.url), "utf8");

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Текст раздела «Для поиска коммерческих потерь» — до следующего заголовка. */
function kbSection(): string {
  const md = readFileSync(new URL(`../../../knowledge-base/${KB_DOC}`, import.meta.url), "utf8");
  const start = md.indexOf(`### ${KB_SECTION}`);
  assert.ok(start >= 0, `в ${KB_DOC} нет раздела «${KB_SECTION}»`);
  const rest = md.slice(start + 4 + KB_SECTION.length);
  const end = rest.search(/\n#{2,3} /);
  return squash(end >= 0 ? rest.slice(0, end) : rest);
}

describe("ограничение №1: правила проверки — из базы знаний", () => {
  const section = kbSection();

  test("каждая цитата, на которой держится проверка, есть в разделе дословно", () => {
    for (const [key, quote] of Object.entries(KB_QUOTES)) {
      assert.ok(section.includes(squash(quote)), `цитаты ${key} нет в разделе: «${quote}»`);
    }
    for (const quote of Object.values(REQUIREMENT_QUOTES)) assert.ok(section.includes(squash(quote)));
  });

  test("пороги логики соответствуют формулировкам базы", () => {
    // «глубина архива не менее одного года» → год = 365 календарных дней включительно (см. ARCHIVE_MIN_DAYS).
    assert.ok(section.includes("не менее одного года"));
    assert.equal(ARCHIVE_MIN_DAYS, 365);
    // «Часовые или получасовые интервалы желательны» → шаг не длиннее часа, и это не блокирует итог.
    assert.ok(section.includes("Часовые или получасовые интервалы желательны"));
    assert.equal(INTERVAL_MAX_MINUTES, 60);
    // «Минимально достаточно суточных данных с разбивкой на день и ночь».
    assert.ok(section.includes("суточное потребление с разбивкой на дневное и ночное"));
    assert.ok(section.includes("Минимально достаточно суточных данных с разбивкой на день и ночь"));
  });

  test("в подписях на экране нет чисел, которых нет в базе", () => {
    for (const text of [...Object.values(REQUIREMENT_LABELS), ...Object.values(KB_QUOTES)]) {
      for (const n of text.match(/\d+/g) ?? []) assert.ok(section.includes(n), `число ${n} не из базы: «${text}»`);
    }
  });
});

describe("четыре синтетические выгрузки", () => {
  test("полная: год суточных данных день/ночь, все колонки → достаточно", () => {
    const r = checkCsv(fixture("full.csv"));
    assert.equal(r.table.delimiter, ";");
    assert.deepEqual(r.readiness.missing, []);
    assert.equal(r.readiness.ready, true);
    assert.equal(r.from, "2025-01-01");
    assert.equal(r.to, "2025-12-31");
    assert.equal(r.archiveDays, 365);
    // Суточные данные: часовых интервалов нет, но это только «желательно».
    assert.equal(r.readiness.flags.intervals, false);
    assert.equal(r.stepMinutes, 24 * 60);
  });

  test("без разбивки день/ночь → не хватает разбивки", () => {
    const r = checkCsv(fixture("no-day-night.csv"));
    assert.equal(r.table.delimiter, ",");
    assert.equal(r.readiness.ready, false);
    assert.deepEqual(r.readiness.missing, ["dailyDayNight"]);
    assert.equal(r.readiness.flags.readings, true);
    // Адрес с запятой в кавычках не разъехался по колонкам.
    assert.equal(r.table.rows[0][r.mapping.address!], "ул. Тестовая, 1");
  });

  test("архив 8 месяцев → не хватает глубины архива", () => {
    const r = checkCsv(fixture("archive-8-months.csv"));
    assert.equal(r.readiness.ready, false);
    assert.deepEqual(r.readiness.missing, ["archiveYear"]);
    assert.equal(r.archiveDays, 243);
  });

  test("без серийных номеров → не хватает серийного номера", () => {
    const r = checkCsv(fixture("no-serial.csv"));
    assert.equal(r.readiness.ready, false);
    assert.deepEqual(r.readiness.missing, ["serial"]);
  });

  test("итог — только флаги и ключи, без значений из файла", () => {
    const { readiness } = checkCsv(fixture("full.csv"));
    assert.deepEqual(Object.keys(readiness).sort(), ["flags", "missing", "ready"]);
    for (const v of Object.values(readiness.flags)) assert.equal(typeof v, "boolean");
    const json = JSON.stringify(checkCsv(fixture("no-serial.csv")).readiness);
    assert.ok(!json.includes("TEST-") && !json.includes("Тестовая"));
  });
});

describe("сопоставление колонок", () => {
  test("русские и английские синонимы", () => {
    const cases: [string, string | undefined][] = [
      ["ID канала учёта", "channel"],
      ["Ид", "channel"],
      ["channel_id", "channel"],
      ["Дата", "date"],
      ["date", "date"],
      ["Время", "time"],
      ["Показание", "reading"],
      ["reading_kwh", "reading"],
      ["День (T1)", "day"],
      ["Т1", "day"],
      ["Потребление днём", "day"],
      ["Ночь", "night"],
      ["T2", "night"],
      ["Адрес установки", "address"],
      ["Серийный номер", "serial"],
      ["serial_number", "serial"],
      ["Зав. №", "serial"],
      ["Категория абонента", "category"],
      ["Комментарий", undefined],
    ];
    for (const [header, role] of cases) assert.equal(guessRole(header), role, header);
  });

  test("колонка достаётся одной роли; серийник с «ID» не путается с каналом", () => {
    assert.deepEqual(autoMap(["Серийный номер (ID прибора)", "ID канала", "Дата"]), { serial: 0, channel: 1, date: 2 });
  });

  test("ручная правка снимает колонку с прежней роли и пересчитывает итог", () => {
    const table = readTable(fixture("no-serial.csv"));
    const auto = autoMap(table.headers);
    assert.equal(analyze(table, auto).readiness.flags.serial, false);
    // Клиент вручную указал, что серийники лежат в колонке канала (условно): роль канала освобождается.
    const manual = assignColumn(auto, "serial", auto.channel);
    assert.equal(manual.channel, undefined);
    assert.equal(manual.serial, auto.channel);
    const r = analyze(table, manual);
    assert.equal(r.readiness.flags.serial, true);
    assert.deepEqual(r.readiness.missing, ["channelId"]);
    // Снять роль совсем.
    assert.equal(assignColumn(auto, "date", undefined).date, undefined);
  });
});

describe("разбор CSV", () => {
  test("BOM, CRLF, кавычки, двойные кавычки и перевод строки внутри ячейки", () => {
    const rows = parseCsv('\uFEFFa;b;c\r\n"x;1";"он сказал ""да""";"две\nстроки"\r\n\r\n');
    assert.deepEqual(rows, [
      ["a", "b", "c"],
      ["x;1", 'он сказал "да"', "две\nстроки"],
    ]);
  });

  test("разделитель: «;», «,», табуляция; запятые в кавычках не считаются", () => {
    assert.equal(detectDelimiter("a;b;c\n1,5;2,5;3"), ";");
    assert.equal(detectDelimiter('"a;b",c,d\n'), ",");
    assert.equal(detectDelimiter("a\tb\tc"), "\t");
  });

  test("подсказка Excel sep=", () => {
    const t = readTable("sep=,\nканал,дата\n1,01.01.2025\n");
    assert.equal(t.delimiter, ",");
    assert.deepEqual(t.headers, ["канал", "дата"]);
  });

  test("ошибки — понятным текстом", () => {
    assert.throws(() => readTable(""), /пустой/);
    assert.throws(() => readTable("одна колонка\n1\n"), /разделить/);
    assert.throws(() => readTable("канал;дата\n"), /нет ни одной строки данных/);
  });

  test("Windows-1251 и XLSX", () => {
    assert.equal(decodeBytes(new Uint8Array([0xc4, 0xe0, 0xf2, 0xe0])), "Дата");
    assert.equal(decodeBytes(new TextEncoder().encode("Дата")), "Дата");
    assert.equal(looksLikeZip(new Uint8Array([0x50, 0x4b, 3, 4])), true);
    assert.equal(looksLikeZip(new TextEncoder().encode("канал;дата")), false);
  });
});

describe("значения", () => {
  test("даты ДД.ММ.ГГГГ и ISO, с временем и без; несуществующие — null", () => {
    assert.equal(parseDate("05.03.2025"), Date.UTC(2025, 2, 5));
    assert.equal(parseDate("5/3/2025"), Date.UTC(2025, 2, 5));
    assert.equal(parseDate("2025-03-05"), Date.UTC(2025, 2, 5));
    assert.equal(parseDate("2025-03-05T13:30:00"), Date.UTC(2025, 2, 5, 13, 30));
    assert.equal(parseDate("2025-03-05 13:30:00+03:00"), Date.UTC(2025, 2, 5, 13, 30));
    assert.equal(parseDate("05.03.2025 00:30"), Date.UTC(2025, 2, 5, 0, 30));
    assert.equal(parseDate("31.02.2025"), null);
    assert.equal(parseDate("2025-13-01"), null);
    assert.equal(parseDate("вчера"), null);
    assert.equal(parseDate(""), null);
  });

  test("время и интервал", () => {
    assert.equal(parseTime("13:30"), 13 * 60 + 30);
    assert.equal(parseTime("00:30-01:00"), 30);
    assert.equal(parseTime("7"), 7 * 60);
    assert.equal(parseTime("ночь"), null);
  });

  test("числа с запятой и пробелами", () => {
    assert.equal(parseNumber("1 234,5"), 1234.5);
    assert.equal(parseNumber("1\u00A0234,5"), 1234.5);
    assert.equal(parseNumber("1,234.5"), 1234.5);
    assert.equal(parseNumber("-0,5"), -0.5);
    assert.equal(parseNumber(""), null);
    assert.equal(parseNumber("н/д"), null);
  });
});

describe("пороги", () => {
  const daily = (from: string, count: number, extra = "") => {
    const lines = ["канал;дата;день;ночь;показание;адрес;серийный номер;категория" + extra];
    const start = Date.parse(`${from}T00:00:00Z`);
    for (let i = 0; i < count; i++) {
      const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
      lines.push(`TEST-1;${d};1;1;${i};ул. Тестовая, 1;TEST-SN-1;Население`);
    }
    return lines.join("\n");
  };

  test("архив: 365 дат включительно — год, 364 — нет", () => {
    assert.equal(checkCsv(daily("2025-01-01", 365)).readiness.flags.archiveYear, true);
    assert.equal(checkCsv(daily("2025-01-01", 364)).readiness.flags.archiveYear, false);
    // Через високосный февраль: 1 марта 2023 — 29 февраля 2024 = 366 дат, 1 марта 2023 — 28 февраля 2024 = 365.
    assert.equal(checkCsv(daily("2023-03-01", 365)).readiness.flags.archiveYear, true);
  });

  test("часовые и получасовые интервалы распознаются, суточные — нет", () => {
    const halfHour = ["канал;дата и время;показание"];
    for (let i = 0; i < 96; i++) {
      const t = new Date(Date.UTC(2025, 0, 1) + i * 30 * 60_000).toISOString().slice(0, 16);
      halfHour.push(`TEST-1;${t};${i}`);
    }
    const r = checkCsv(halfHour.join("\n"));
    assert.equal(r.stepMinutes, 30);
    assert.equal(r.readiness.flags.intervals, true);

    const hourly = ["канал;дата;час;показание"];
    for (let h = 0; h < 48; h++) hourly.push(`TEST-1;${h < 24 ? "01.01.2025" : "02.01.2025"};${h % 24}:00;${h}`);
    assert.equal(checkCsv(hourly.join("\n")).stepMinutes, 60);

    assert.equal(checkCsv(daily("2025-01-01", 30)).readiness.flags.intervals, false);
  });
});

describe("ссылка на раздел базы", () => {
  test("находит раздел по документу и заголовку", () => {
    const docs = [
      { doc: "20-products/24-losses.md", chunks: [{ id: "aaa", path: "Поиск коммерческих потерь электроэнергии" }] },
      {
        doc: KB_DOC,
        chunks: [
          { id: "bbb", path: "Какие сведения могут понадобиться > Для учёта" },
          { id: "ccc", path: `Какие сведения могут понадобиться > ${KB_SECTION}` },
        ],
      },
    ];
    assert.equal(kbSectionHref(docs), "/kb?chunk=ccc");
  });

  test("без базы — ссылка на документ", () => {
    assert.equal(kbSectionHref(null), `/kb?doc=${encodeURIComponent(KB_DOC)}`);
  });
});
