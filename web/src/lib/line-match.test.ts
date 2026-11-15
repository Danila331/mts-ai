import assert from "node:assert/strict";
import { test } from "node:test";
import { bestCitationLine, bestLine, numbersIn, parseHl, stems, textLines } from "./line-match.ts";

const TABLE = [
  "Тариф: Базовый; Срок: 10 дней; Оговорка: без выезда",
  "Тариф: Расширенный; Срок: 3 дня; Оговорка: с выездом инженера",
  "",
  "Подключение занимает 30 рабочих дней после оплаты.",
].join("\n");

test("основы: первые 5 букв, ё=е, короткие слова отбрасываются", () => {
  assert.deepEqual([...stems("Подключение счётчиков и ёлки")].sort(), ["ёлки".replace("ё", "е"), "подкл", "счетч"].sort());
});

test("числа: запятая, пробел тысяч, мелкие целые игнорируются", () => {
  assert.deepEqual([...numbersIn("1 200 руб, 2,5 кВт и 1 шт, 30 дней")].sort(), ["1200", "2.5", "30"]);
});

test("пустые строки не считаются", () => {
  assert.equal(textLines(TABLE).length, 3);
});

test("находит строку таблицы по числу и словам", () => {
  const m = bestLine("Расширенный тариф даёт срок 3 дня", TABLE);
  assert.equal(m?.line, 1);
  assert.deepEqual(m?.numbers, ["3"]);
});

test("число решает при равных словах", () => {
  const m = bestLine("Подключение занимает 30 рабочих дней", TABLE);
  assert.equal(m?.line, 2);
  assert.deepEqual(m?.numbers, ["30"]);
});

test("слабое совпадение — null", () => {
  assert.equal(bestLine("Погода сегодня солнечная", TABLE), null);
  assert.equal(bestLine("", TABLE), null);
});

test("bestCitationLine берёт предложение, у которого раздел в опоре", () => {
  const citations = [
    { sentence: "Привет!", support: [] },
    { sentence: "Базовый тариф: срок 10 дней.", support: [{ id: "a" }] },
    { sentence: "Расширенный тариф с выездом инженера.", support: [{ id: "b" }] },
  ];
  assert.equal(bestCitationLine(citations, "a", TABLE)?.line, 0);
  assert.equal(bestCitationLine(citations, "b", TABLE)?.line, 1);
  assert.equal(bestCitationLine(citations, "zzz", TABLE), null);
});

test("parseHl принимает только индекс", () => {
  assert.equal(parseHl("3"), 3);
  assert.equal(parseHl("0"), 0);
  assert.equal(parseHl("Иван Иванов"), undefined);
  assert.equal(parseHl(null), undefined);
});
