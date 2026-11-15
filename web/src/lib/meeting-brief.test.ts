// node --experimental-strip-types --test src/lib/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { LEAD_KINDS } from "./lead-kinds.ts";
import {
  COMMON_LIMITS,
  LIMITS_BY_PRODUCT,
  NO_PROMISE,
  PREPARE,
  SPECIALIST,
  briefHtml,
  briefText,
  buildBrief,
  type BriefInput,
  type KbFacts,
} from "./meeting-brief.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Текст раздела документа базы до следующего заголовка уровня 1–3. */
function kbSection(doc: string, section: string): string {
  const md = read(`../../../knowledge-base/${doc}`);
  const head = md.match(new RegExp(`^#{2,3} ${section}\\s*$`, "m"));
  assert.ok(head?.index !== undefined, `в ${doc} нет раздела «${section}»`);
  const rest = md.slice(head.index + head[0].length);
  const end = rest.search(/\n#{1,3} /);
  return squash(end >= 0 ? rest.slice(0, end) : rest);
}

/** Обещания, которых база не разрешает: точное время, срок звонка, имя специалиста — и цены. */
const PROMISE =
  /\d{1,2}[:.]\d{2}|через \d+|\d+\s*(мин|час)|в течение|сегодня|завтра|перезвоним в|позвоним в|до конца (дня|недели)|в ближайш/i;
const NAMED = /(?:[Сс]пециалист|[Мм]енеджер)\s+[А-ЯЁ][а-яё]+/;
const PRICE = /руб|₽|тыс\.|млн|\d\s*%|\bцена\b|стоит \d/i;
const forbidden = (s: string) => PROMISE.test(s) || NAMED.test(s) || PRICE.test(s);

const allFacts = (): KbFacts[] => [
  ...Object.values(PREPARE),
  ...Object.values(LIMITS_BY_PRODUCT),
  COMMON_LIMITS,
  ...NO_PROMISE,
  SPECIALIST,
];

const sample = (over: Partial<BriefInput> = {}): BriefInput => ({
  code: "2194618e2c",
  company: "ООО Учебный склад",
  name: "Тестов Тест Тестович",
  kind: "callback",
  product: "platform",
  product_label: "Платформа учёта",
  grade_label: "Горячая",
  callback_label: "вечер, часовой пояс Europe/Moscow",
  score: { missing: ["Схема сбора данных", "Учёт по чему: цеха, объекты"] },
  passport: { fields: [{ label: "Регион", value: "Тверская область", group: "general" }, { label: "Телефон", value: "+79000000000", group: "contacts" }] },
  ...over,
});

describe("T25: шпаргалка к встрече", () => {
  test("каждая формулировка есть дословно в своём разделе базы", () => {
    for (const f of allFacts()) {
      const text = kbSection(f.doc, f.section);
      for (const item of f.items) assert.ok(text.includes(item), `«${item}» нет в ${f.doc}, «${f.section}»`);
    }
  });

  test("тексты шпаргалки без времени звонка, имён, сроков и цен — для каждого продукта и типа заявки", () => {
    const products = ["general", "wholesale", "solar", "platform", "losses", "recognition"] as const;
    for (const product of products) {
      for (const k of LEAD_KINDS) {
        const brief = buildBrief(sample({ product, kind: k.kind, score: { missing: [] } }));
        for (const s of brief.sections) {
          for (const item of s.items) {
            // Пункты про время звонка — сами запреты («Нельзя обещать точное время…»): проверяем остальные.
            assert.ok(!forbidden(item), `${product}/${k.kind}: «${item}»`);
          }
        }
      }
    }
  });

  test("«что спросить» — то, что посчитал скоринг; без него — общая строка", () => {
    const ask = buildBrief(sample()).sections.find((s) => s.id === "ask")!;
    assert.deepEqual(ask.items, ["Схема сбора данных", "Учёт по чему: цеха, объекты"]);
    const done = buildBrief(sample({ score: { missing: [] } })).sections.find((s) => s.id === "ask")!;
    assert.equal(done.items.length, 1);
  });

  test("продукт определяет чек-лист и границы; без продукта — общие", () => {
    const platform = buildBrief(sample());
    assert.ok(platform.sections.find((s) => s.id === "prepare")!.items.includes("количество и тип приборов"));
    assert.ok(platform.sections.find((s) => s.id === "limits")!.items.some((i) => i.includes("не выставляет счета")));
    const general = buildBrief(sample({ product: "general", product_label: "не определён" }));
    const prepare = general.sections.find((s) => s.id === "prepare")!;
    assert.equal(prepare.items.length, PREPARE.general.items.length);
    assert.ok(general.sections.find((s) => s.id === "known")!.items[0].includes("пока не определён"));
  });

  test("удобное время — пожелание, а не договорённость; контакты в шпаргалку не попадают", () => {
    const known = buildBrief(sample()).sections.find((s) => s.id === "known")!.items.join("\n");
    assert.match(known, /пожелание, не договорённость/);
    assert.ok(!known.includes("+7900"), "телефон не копируем в лист, который печатают");
    assert.match(known, /Регион: Тверская область/);
  });

  test("текст и печатная страница: источники указаны, html экранирован", () => {
    const brief = buildBrief(sample({ company: '<script>alert("x")</script>' }));
    const html = briefHtml(brief);
    assert.ok(!html.includes("<script>"));
    assert.match(html, /&lt;script&gt;/);
    const text = briefText(brief);
    assert.match(text, /ЧЕГО НЕ ОБЕЩАТЬ/);
    assert.match(text, /00-reference\/03-calculation-and-requests\.md/);
  });
});
