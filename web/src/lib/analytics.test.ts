// node --experimental-strip-types --test src/lib/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { barWidth, gapsText, percent, stepKept } from "./analytics.ts";

describe("T6: аналитика", () => {
  test("доли и сохранение между шагами воронки", () => {
    const funnel = [
      { key: "a", label: "Сессии", count: 20, share: 1 },
      { key: "b", label: "Ответ", count: 10, share: 0.5 },
      { key: "c", label: "Паспорт", count: 0, share: 0 },
      { key: "d", label: "Заявка", count: 0, share: 0 },
    ];
    assert.equal(stepKept(funnel, 0), "—");
    assert.equal(stepKept(funnel, 1), "50%");
    assert.equal(stepKept(funnel, 2), "0%");
    assert.equal(stepKept(funnel, 3), "—", "предыдущий шаг пуст — деления на ноль нет");
    assert.equal(percent(0.376), "38%");
    assert.equal(percent(0, 0), "—");
  });

  test("полоса: ноль — пусто, малое значение — всё равно видно", () => {
    assert.equal(barWidth(0, 10), 0);
    assert.equal(barWidth(1, 1000), 2);
    assert.equal(barWidth(10, 10), 100);
    assert.equal(barWidth(5, 0), 0);
  });

  test("пробелы текстом для команды контента", () => {
    assert.equal(gapsText([], 7), "");
    const text = gapsText([{ question: "Сколько стоит [телефон]?", count: 2, last_at: "2026-11-16T10:00:00Z" }], 30);
    assert.match(text, /за 30 дн/);
    assert.match(text, /2 × Сколько стоит \[телефон\]\?/);
  });
});
