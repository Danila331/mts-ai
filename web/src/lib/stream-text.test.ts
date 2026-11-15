// node --experimental-strip-types --test src/lib/*.test.ts (npm test): потоковая выдача ответа (T13).
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendDelta, isRevised, parseStreamFlag, tidyStream } from "./stream-text.ts";

const BAD = "Ориентир — 25 000 руб в год за прибор. Итого проект обойдётся в 3 750 000 рублей. Сколько у вас объектов?";
const GOOD = "Ориентир — 25 000 руб в год за прибор, на объёмных внедрениях стоимость считается отдельно. Сколько у вас объектов?";

const typed = (...pieces: string[]) => pieces.reduce((acc, text) => appendDelta(acc, { text }), "");

test("дельты складываются по порядку, мусор пропускается", () => {
  assert.equal(typed("Ори", "ентир", " — 25 000"), "Ориентир — 25 000");
  assert.equal(appendDelta("а", null), "а");
  assert.equal(appendDelta("а", { text: 5 }), "а");
  assert.equal(appendDelta("а", {}), "а");
});

test("печатаемый текст чистится как tidy() ядра", () => {
  assert.equal(tidyStream("Консультант: **Да**, можно:\n- первый факт\n- второй факт\n"), "Да, можно: первый факт второй факт");
  assert.equal(tidyStream("## Итог\n1. Шаг"), "Итог Шаг");
  assert.equal(tidyStream("  слово  "), "слово");
});

test("финальный answer главнее дельт: guard переписал — метка", () => {
  const streamed = typed(...BAD.split(/(?<= )/));
  assert.equal(streamed, BAD);
  assert.equal(isRevised(streamed, { text: GOOD }), true, "без поля revised — сравнение здесь");
  assert.equal(isRevised(streamed, { text: GOOD, revised: true }), true);
  assert.equal(isRevised(streamed, { text: BAD, revised: false }), false, "ядро сравнивает после своей чистки");
  assert.equal(isRevised("**Да**, можно", { text: "Да, можно" }), false, "разница только в разметке — не правка");
});

test("ничего не напечатано — метки нет", () => {
  assert.equal(isRevised("", { text: GOOD, revised: true }), false);
  assert.equal(isRevised("   ", { text: GOOD }), false);
});

test("data-stream: выключатель потоковой выдачи виджета", () => {
  for (const off of ["0", "false", "OFF", " no "]) assert.equal(parseStreamFlag(off), false, off);
  for (const on of ["1", "true", "on", "yes"]) assert.equal(parseStreamFlag(on), true, on);
  for (const unset of [undefined, null, "", "auto", 0]) assert.equal(parseStreamFlag(unset), undefined, String(unset));
  assert.equal(parseStreamFlag(false), false);
});
