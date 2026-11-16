// Синтетические выгрузки для проверки готовности данных (T21): `node scripts/readiness-fixtures.mjs`.
// Только выдуманные данные: каналы TEST-*, адреса «ул. Тестовая», серийники TEST-SN-*.
// Файлы пишутся в src/lib/fixtures/readiness/, их читает src/lib/data-readiness.test.ts и их же удобно
// загрузить на экран /check-data руками.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "../src/lib/fixtures/readiness");
mkdirSync(out, { recursive: true });

// Детерминированный генератор: одинаковые файлы при каждом запуске.
let seed = 20251;
const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);

const CHANNELS = [
  { id: "TEST-0001", address: "ул. Тестовая, 1", serial: "TEST-SN-0001", category: "Население" },
  { id: "TEST-0002", address: "ул. Тестовая, 2", serial: "TEST-SN-0002", category: "Прочие потребители" },
];

const days = (from, to) => {
  const list = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    list.push(new Date(d));
  }
  return list;
};
const ru = (d) =>
  `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
const iso = (d) => d.toISOString().slice(0, 10);
const comma = (n) => n.toFixed(1).replace(".", ",");
const quote = (s) => (/[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Строки по каналам: показание нарастающим итогом и суточное потребление днём и ночью. */
function* series(from, to) {
  for (const ch of CHANNELS) {
    let total = 1000 + rand() * 500;
    for (const d of days(from, to)) {
      const day = 4 + rand() * 6;
      const night = 2 + rand() * 3;
      total += day + night;
      yield { ch, d, total, day, night };
    }
  }
}

function write(name, text) {
  writeFileSync(join(out, name), text);
  console.log(`${name}: ${text.length} символов`);
}

// 1. Полный: год суточных данных день/ночь, все колонки. BOM, «;», CRLF, ДД.ММ.ГГГГ, десятичная запятая.
write(
  "full.csv",
  "\uFEFF" +
    [
      "ID канала учёта;Дата;Показание, кВт·ч;День (Т1), кВт·ч;Ночь (Т2), кВт·ч;Адрес установки;Серийный номер;Категория абонента",
      ...[...series("2025-01-01", "2025-12-31")].map(({ ch, d, total, day, night }) =>
        [ch.id, ru(d), comma(total), comma(day), comma(night), ch.address, ch.serial, ch.category].join(";"),
      ),
    ].join("\r\n") +
    "\r\n",
);

// 2. Без разбивки день/ночь: только показание. «,», кавычки вокруг адресов, ISO-даты, английские заголовки.
write(
  "no-day-night.csv",
  [
    "channel_id,date,reading_kwh,installation_address,serial_number,customer_category",
    ...[...series("2025-01-01", "2025-12-31")].map(({ ch, d, total }) =>
      [ch.id, iso(d), total.toFixed(1), ch.address, ch.serial, ch.category].map(quote).join(","),
    ),
  ].join("\n") + "\n",
);

// 3. Архив 8 месяцев: январь — август. Короткие заголовки, T1/T2 латиницей.
write(
  "archive-8-months.csv",
  [
    "Ид;Дата показаний;Значение;T1;T2;Адрес;Зав. номер;Категория",
    ...[...series("2025-01-01", "2025-08-31")].map(({ ch, d, total, day, night }) =>
      [ch.id, ru(d), comma(total), comma(day), comma(night), ch.address, ch.serial, ch.category].join(";"),
    ),
  ].join("\n") + "\n",
);

// 4. Без серийных номеров: всё остальное есть.
write(
  "no-serial.csv",
  [
    "Канал учёта;Дата;Показание;Потребление днём;Потребление ночью;Адрес установки прибора;Категория абонента",
    ...[...series("2025-01-01", "2025-12-31")].map(({ ch, d, total, day, night }) =>
      [ch.id, ru(d), comma(total), comma(day), comma(night), ch.address, ch.category].join(";"),
    ),
  ].join("\n") + "\n",
);
