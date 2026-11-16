// node --experimental-strip-types --test src/lib/*.test.ts (npm test): что попадает в плашку «Честно: не подойдёт».
import assert from "node:assert/strict";
import { test } from "node:test";
import { HONEST_NO_MAX, honestNoItems, sameProductAsPrevious, sectionHref, sectionLabel } from "./honest-no.ts";
import type { HonestNo } from "./types.ts";

const section = { chunk_id: "00feb2060c578ae2", doc: "20-products/24-losses.md", title: "Поиск коммерческих потерь электроэнергии", path: "Кому подходит > Не подходит энергосбытовым компаниям" };

const sbyt: HonestNo = {
  rule: "losses_sbyt",
  product: "Поиск коммерческих потерь",
  reason: "Ответственность за потери в сети, включая материальную, несут сетевые организации, а не сбытовые.",
  fact: "энергосбыт",
  section,
  alternative: { text: "Облачная платформа учёта; Распознавание показаний по фото", section: { ...section, chunk_id: "184b45b62fbc5858" } },
};

test("ответ без поля (старое ядро, eval, copilot) — плашки нет", () => {
  assert.deepEqual(honestNoItems(undefined), []);
  assert.deepEqual(honestNoItems({}), []);
  assert.deepEqual(honestNoItems({ honest_no: [] }), []);
});

test("пункт без раздела базы не показываем: «нет» без источника клиенту не говорим", () => {
  assert.deepEqual(honestNoItems({ honest_no: [{ ...sbyt, section: null }] }), []);
  assert.deepEqual(honestNoItems({ honest_no: [{ ...sbyt, section: { ...section, chunk_id: "" } }] }), []);
  assert.deepEqual(honestNoItems({ honest_no: [{ ...sbyt, reason: "  " }] }), []);
});

test("повтор правила убирается, пунктов не больше предела", () => {
  const other = (rule: string): HonestNo => ({ ...sbyt, rule });
  const items = honestNoItems({ honest_no: [sbyt, sbyt, other("a"), other("b"), other("c")] });
  assert.equal(items.length, HONEST_NO_MAX);
  assert.deepEqual(items.map((i) => i.rule), ["losses_sbyt", "a"]);
});

test("альтернатива: пустая — нет, без раздела — текст остаётся без ссылки", () => {
  assert.equal(honestNoItems({ honest_no: [{ ...sbyt, alternative: { text: "", section } }] })[0].alternative, null);
  const alt = honestNoItems({ honest_no: [{ ...sbyt, alternative: { text: "Платформа учёта", section: null } }] })[0].alternative;
  assert.deepEqual(alt, { text: "Платформа учёта", section: null });
});

test("ссылка и подпись раздела", () => {
  assert.equal(sectionHref(section), "/kb?chunk=00feb2060c578ae2");
  assert.equal(sectionHref({ ...section, chunk_id: "a b" }), "/kb?chunk=a%20b");
  assert.equal(sectionLabel(section), "Поиск коммерческих потерь электроэнергии › Не подходит энергосбытовым компаниям");
  assert.equal(sectionLabel({ ...section, title: "", path: "Где оптового рынка нет" }), "Где оптового рынка нет");
});

test("две причины про один продукт — один заголовок (живой прогон: 40 кВт и «магазин» про оптовый рынок)", () => {
  const items = [{ product: "Выход на оптовый рынок" }, { product: "Выход на оптовый рынок" }, { product: "Солнечная станция" }];
  assert.equal(sameProductAsPrevious(items, 0), false);
  assert.equal(sameProductAsPrevious(items, 1), true);
  assert.equal(sameProductAsPrevious(items, 2), false);
});
