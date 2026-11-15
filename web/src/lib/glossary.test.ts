// node --experimental-strip-types --test src/lib/*.test.ts (npm test): глоссарий подсказок к терминам (T16).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { GLOSSARY, glossaryHref, markTerms } from "./glossary.ts";

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Текст раздела базы — от его заголовка до следующего заголовка; разметка выделения убрана. */
function kbSection(doc: string, heading: string): string {
  const md = readFileSync(new URL(`../../../knowledge-base/${doc}`, import.meta.url), "utf8");
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^#{1,3} /.test(l) && l.replace(/^#+ /, "").trim() === heading);
  assert.ok(start >= 0, `в ${doc} нет раздела «${heading}»`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,3} /.test(l));
  return squash((end < 0 ? rest : rest.slice(0, end)).join("\n").replace(/\*\*/g, ""));
}

describe("глоссарий: определения — из базы", () => {
  for (const e of GLOSSARY) {
    test(`${e.term}: определение есть в разделе «${e.section}»`, () => {
      assert.ok(kbSection(e.doc, e.section).includes(squash(e.definition)), `нет в ${e.doc}: ${e.definition}`);
    });
  }

  test("записи не повторяются и у каждой есть всё нужное", () => {
    assert.equal(new Set(GLOSSARY.map((e) => e.id)).size, GLOSSARY.length);
    for (const e of GLOSSARY) {
      assert.ok(e.term && e.definition && e.doc && e.section, e.id);
      assert.doesNotThrow(() => new RegExp(e.pattern, "iu"), e.id);
    }
  });

  test("определение — без слов от себя: короткий фрагмент, не пересказ", () => {
    for (const e of GLOSSARY) assert.ok(e.definition.length <= 260, `${e.id}: ${e.definition.length}`);
  });
});

describe("разметка терминов в ответе", () => {
  const terms = (text: string, seen?: Set<string>) =>
    markTerms(text, seen)
      .filter((p) => p.entry)
      .map((p) => `${p.entry!.id}:${p.text}`);

  test("находит термины в разных падежах и не склеивает текст", () => {
    const text = "Присоединённая мощность определяет порог: от 670 кВт нужен почасовой интервальный учёт.";
    assert.deepEqual(terms(text), [
      "connected-power:Присоединённая мощность",
      "kw:кВт",
      "interval-metering:почасовой интервальный учёт",
    ]);
    assert.equal(markTerms(text).map((p) => p.text).join(""), text);
  });

  test("кВт не путается с кВт·ч, а слова с корнем «энерги» не считаются термином", () => {
    assert.deepEqual(terms("Платите за 400 кВт·ч в месяц."), ["kwh:кВт·ч"]);
    assert.deepEqual(terms("Платите за киловатт-часы."), ["kwh:киловатт-часы"]);
    assert.deepEqual(terms("Электроэнергия дорожает."), []);
    assert.deepEqual(terms("Реактивной энергии стало больше."), ["reactive:Реактивной энергии"]);
  });

  test("«присоединённая мощность» важнее «кВт» и не режется пополам", () => {
    assert.deepEqual(terms("Присоединённая (максимальная) мощность 750 кВт"), [
      "connected-power:Присоединённая (максимальная) мощность",
      "kw:кВт",
    ]);
  });

  test("каждый термин размечается один раз за ответ", () => {
    const seen = new Set<string>();
    assert.deepEqual(terms("Оптовый рынок доступен от 750 кВт.", seen), ["wholesale-market:Оптовый рынок", "kw:кВт"]);
    assert.deepEqual(terms("На оптовом рынке цена другая, до 20 МВт.", seen), []);
  });

  test("аббревиатуры — только целым словом", () => {
    assert.deepEqual(terms("Для ГТП нужен АСКУЭ."), ["gtp:ГТП", "askue:АСКУЭ"]);
    assert.deepEqual(terms("ГТПЭ и АСКУЭС — не термины"), []);
  });

  test("текст без терминов остаётся как есть", () => {
    const text = "Поиск потерь работает с выгрузкой данных учёта.";
    assert.deepEqual(markTerms(text), [{ text }]);
  });
});

describe("ссылка на раздел базы", () => {
  const kb = {
    docs: [
      {
        doc: "10-energy/17-faq.md",
        title: "Частые вопросы по энергетике",
        chunks: [{ id: "abc123", path: "Частые вопросы по энергетике > Что такое небаланс" }],
      },
    ],
  };

  test("id раздела берётся из /api/kb, а не зашит", () => {
    const e = GLOSSARY.find((g) => g.id === "imbalance")!;
    assert.equal(glossaryHref(e, kb), "/kb?chunk=abc123");
  });

  test("без базы или без раздела — ссылка на документ", () => {
    const e = GLOSSARY.find((g) => g.id === "imbalance")!;
    assert.equal(glossaryHref(e, null), "/kb?doc=10-energy%2F17-faq.md");
    assert.equal(glossaryHref(GLOSSARY.find((g) => g.id === "gtp")!, kb), "/kb?doc=10-energy%2F17-faq.md");
  });
});
