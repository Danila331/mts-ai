// node --experimental-strip-types --test src/lib/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { LEAD_KINDS, guessKind, kindInfo, kindsFor } from "./lead-kinds.ts";

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

describe("T17: четыре типа заявки", () => {
  test("у каждого типа есть основание в базе — цитаты из своего раздела", () => {
    for (const k of LEAD_KINDS) {
      const text = kbSection(k.kb.doc, k.kb.section);
      for (const q of k.kb.quotes) assert.ok(text.includes(q), `${k.kind}: «${q}» нет в «${k.kb.section}»`);
    }
  });

  test("солнечная станция — без демо-кабинета и пилота; платформа учёта — все четыре", () => {
    assert.deepEqual(kindsFor(["solar"]).map((k) => k.kind), ["callback", "assessment"]);
    assert.deepEqual(kindsFor([]).map((k) => k.kind), ["callback", "assessment"]);
    assert.deepEqual(kindsFor(["platform"]).map((k) => k.kind), ["callback", "assessment", "demo", "pilot"]);
    assert.deepEqual(kindsFor(["wholesale", "platform"]).map((k) => k.kind), ["callback", "assessment", "demo", "pilot"]);
  });

  test("та же таблица, что на сервере (lead.Kinds)", () => {
    const go = read("../../../backend/internal/lead/kind.go");
    const server = [...go.matchAll(/\{Kind(\w+), "[^"]+", (nil|\[\]passport\.Group\{([^}]*)\})/g)].map((m) => ({
      kind: m[1].toLowerCase(),
      products: m[2] === "nil" ? null : m[3].split(",").map((p) => p.trim().replace("passport.", "").toLowerCase()),
    }));
    assert.deepEqual(
      server,
      LEAD_KINDS.map((k) => ({ kind: k.kind, products: k.products })),
    );
  });

  test("тексты по формулировкам базы: оценка — не КП, срок не обещаем", () => {
    const a = kindInfo("assessment");
    assert.match(a.hint, /Не является коммерческим предложением/);
    assert.match(a.note, /не является коммерческим предложением/);
    assert.match(a.note, /заранее не обещаем/);
  });

  test("предвыбор — только среди подходящих", () => {
    const solar = kindsFor(["solar"]);
    const platform = kindsFor(["platform"]);
    assert.equal(guessKind("Покажите демо кабинета", platform), "demo");
    assert.equal(guessKind("Покажите демо кабинета", solar), "callback");
    assert.equal(guessKind("хотим сначала попробовать на одном счётчике", platform), "pilot");
    assert.equal(guessKind("Посчитайте окупаемость станции", solar), "assessment");
    assert.equal(guessKind("Перезвоните мне", platform), "callback");
  });
});
