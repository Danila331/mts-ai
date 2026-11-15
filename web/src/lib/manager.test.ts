// node --experimental-strip-types --test src/lib/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { STATUS_LABEL, ago, leadTitle, newCodes, newestFirst, waiting } from "./manager.ts";

describe("T5: список заявок менеджера", () => {
  test("первая загрузка ничего не подсвечивает, дальше — только новые номера", () => {
    const items = [{ code: "a1" }, { code: "b2" }];
    assert.deepEqual(newCodes(null, items), []);
    assert.deepEqual(newCodes(new Set(["a1", "b2"]), items), []);
    assert.deepEqual(newCodes(new Set(["a1"]), [{ code: "c3" }, ...items]), ["c3", "b2"]);
  });

  test("новые сверху", () => {
    const sorted = newestFirst([
      { code: "old", created_at: "2026-11-16T10:00:00Z" },
      { code: "new", created_at: "2026-11-16T12:00:00Z" },
    ]);
    assert.deepEqual(sorted.map((i) => i.code), ["new", "old"]);
  });

  test("«сколько назад»", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    assert.equal(ago("2026-11-16T11:59:50Z", now), "только что");
    assert.equal(ago("2026-11-16T11:55:00Z", now), "5 мин назад");
    assert.equal(ago("2026-11-16T09:00:00Z", now), "3 ч назад");
    assert.equal(ago("2026-11-14T12:00:00Z", now), "2 дн назад");
  });

  test("«ждёт N»", () => {
    const now = Date.parse("2026-11-16T12:00:00Z");
    assert.equal(waiting("2026-11-16T11:59:50Z", now), "ждёт меньше минуты");
    assert.equal(waiting("2026-11-16T11:55:00Z", now), "ждёт 5 мин");
  });

  test("четыре статуса и заголовок без компании", () => {
    assert.deepEqual(Object.keys(STATUS_LABEL), ["new", "in_progress", "done", "rejected"]);
    assert.equal(leadTitle({ company: "", name: "Тестов Тест Тестович" }), "Тестов Тест Тестович");
    assert.equal(leadTitle({ company: "", name: "" }), "Без названия");
  });

  test("статусы и подписи те же, что на сервере (lead.Statuses)", () => {
    const go = readFileSync(new URL("../../../backend/internal/lead/status.go", import.meta.url), "utf8");
    const server = [...go.matchAll(/\{Status(\w+), "([^"]+)"\}/g)].map((m) => [
      m[1].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
      m[2],
    ]);
    assert.deepEqual(server, Object.entries(STATUS_LABEL));
  });
});
