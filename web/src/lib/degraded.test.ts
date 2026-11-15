// node --experimental-strip-types --test src/lib/*.test.ts (npm test): блок «вот что есть в материалах» и баннер статуса.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEGRADED_MAX, degradedHref, degradedSections, statusBanner } from "./degraded.ts";
import type { DegradedSection, Health } from "./types.ts";

const section = (id: string, excerpt = "Текст раздела"): DegradedSection => ({
  chunk_id: id,
  doc: "20-products/21-askue.md",
  title: "Платформа учёта",
  path: "Тарифы",
  excerpt,
});

const health = (over: Partial<Health> = {}): Health => ({ ok: true, llm: true, ...over }) as Health;

test("ответ без degraded (обычный, eval, старое ядро) — блока нет", () => {
  assert.deepEqual(degradedSections(undefined), []);
  assert.deepEqual(degradedSections({}), []);
  assert.deepEqual(degradedSections({ degraded: { reason: "model_error", sections: [] } }), []);
});

test("разделы без id или текста не показываем, повторы убираем, не больше предела", () => {
  const sections = [section(""), section("a", "  "), section("b"), section("b"), section("c"), section("d"), section("e")];
  const out = degradedSections({ degraded: { reason: "model_error", sections } });
  assert.deepEqual(out.map((s) => s.chunk_id), ["b", "c", "d"]);
  assert.equal(out.length, DEGRADED_MAX);
});

test("ссылка ведёт в раздел базы", () => {
  assert.equal(degradedHref({ chunk_id: "00feb2060c578ae2" }), "/kb?chunk=00feb2060c578ae2");
  assert.equal(degradedHref({ chunk_id: "a b" }), "/kb?chunk=a%20b");
});

test("баннер: здоровая система молчит", () => {
  assert.equal(statusBanner({ health: null, unreachable: false }), null);
  assert.equal(statusBanner({ health: health(), unreachable: false }), null);
  assert.equal(statusBanner({ health: health({ dense: false, reranker: false }), unreachable: false }), null, "простые ступени поиска клиенту не показываем");
});

test("баннер: ядро не отвечает — «перезапускается», без технических деталей", () => {
  const b = statusBanner({ health: null, unreachable: true });
  assert.equal(b?.tone, "danger");
  assert.match(b!.title, /перезапускается/);
  assert.doesNotMatch(`${b!.title} ${b!.text}`, /HTTP|502|503|API|LLM|модел/i);
});

test("баннер: нет модели или последний ответ пришёл без неё — упрощённый режим", () => {
  for (const input of [
    { health: health({ llm: false }), unreachable: false },
    { health: health(), unreachable: false, answerDegraded: true },
  ]) {
    const b = statusBanner(input);
    assert.equal(b?.tone, "warning");
    assert.doesNotMatch(`${b!.title} ${b!.text}`, /HTTP|502|503|API|LLM|модел/i);
  }
});
