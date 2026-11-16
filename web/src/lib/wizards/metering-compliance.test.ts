// node --experimental-strip-types --test src/lib/*.test.ts src/lib/*/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type WizardAnswers, answer, evaluate, nextStep } from "./engine.ts";
import { FLOWS, METERING_COMPLIANCE as F } from "./flows/index.ts";

/** Присоединённая мощность в кВт → вариант ответа по границам таблицы базы («выше 15», «выше 60», «от 150», «от 670»…). */
function powerOption(kw: number): string {
  if (kw >= 20_000) return "p20";
  if (kw >= 750) return "p750";
  if (kw >= 670) return "p670";
  if (kw >= 150) return "p150";
  if (kw > 60) return "p60";
  if (kw > 15) return "p15";
  return "le15";
}

function run(kw: number, rest: { voltage?: string; category?: string; metering?: string }) {
  let a: WizardAnswers = {};
  const choices = { power: powerOption(kw), voltage: "other", category: "unknown", metering: "unknown", ...rest };
  for (const [step, option] of Object.entries(choices)) a = answer(a, step, { option });
  assert.equal(nextStep(F, a), undefined);
  const r = evaluate(F, a);
  return { outcomes: r.outcomes.map((o) => o.id), notes: r.notes.map((n) => n.id) };
}

const REQ = ["req_15", "req_60", "req_150", "req_670"];

describe("«Чек-лист соответствия учёта по мощности» (T20): итог по таблицам базы", () => {
  test("мастер в реестре", () => assert.ok(FLOWS.includes(F)));

  test("границы мощности: «выше 15», «выше 60», «от 150», «от 670», «от 750», «от 20 МВт»", () => {
    assert.deepEqual(
      [15, 16, 60, 61, 149, 150, 669, 670, 749, 750, 19_999, 20_000].map(powerOption),
      ["le15", "p15", "p15", "p60", "p60", "p150", "p150", "p670", "p670", "p750", "p750", "p20"],
    );
  });

  test("500 кВт: до 670 почасовой учёт не обязателен; обязательны трёхфазный, ТТ и реактивная энергия; опта нет", () => {
    const r = run(500, { category: "c12", metering: "zonal" });
    assert.deepEqual(r.outcomes, ["ok_below"]);
    assert.deepEqual(r.notes.filter((n) => REQ.includes(n) || n.startsWith("market")), ["req_15", "req_60", "req_150", "market_closed"]);
  });

  test("700 кВт: почасовой учёт обязателен, а опт ещё закрыт — пороги 670 и 750 не смешиваются", () => {
    const need = run(700, { category: "c12", metering: "single" });
    assert.deepEqual(need.outcomes, ["need_hourly", "need_category", "check_accuracy_670"]);
    assert.deepEqual(need.notes.filter((n) => REQ.includes(n) || n.startsWith("market")), [...REQ, "market_closed"]);
    assert.deepEqual(run(700, { category: "c36", metering: "hourly" }).outcomes, ["check_accuracy_670", "ok_hourly"]);
    assert.deepEqual(run(700, { metering: "unknown" }).outcomes, ["check_hourly", "check_accuracy_670"]);
  });

  test("800 кВт: опт только через сбытовую компанию, почасовой учёт обязателен", () => {
    const r = run(800, { category: "c36", metering: "hourly" });
    assert.deepEqual(r.outcomes, ["check_accuracy_670", "ok_hourly"]);
    assert.ok(r.notes.includes("market_supplier") && !r.notes.includes("market_closed") && !r.notes.includes("market_direct"));
    assert.deepEqual(run(800, { metering: "zonal" }).outcomes.slice(0, 1), ["need_hourly"]);
  });

  test("25 МВт: прямое участие возможно, требования учёта те же, что от 670 кВт", () => {
    const r = run(25_000, { category: "c36", metering: "hourly" });
    assert.deepEqual(r.outcomes, ["check_accuracy_670", "ok_hourly"]);
    assert.ok(r.notes.includes("market_direct") && !r.notes.includes("market_supplier"));
    assert.deepEqual(r.notes.filter((n) => REQ.includes(n)), REQ);
  });

  test("ниже 670 кВт: категории с третьей по шестую без интервальных данных — проверить; 6-10 кВ — отдельная проверка", () => {
    assert.deepEqual(run(100, { category: "c36", metering: "single" }).outcomes, ["check_category_data"]);
    assert.deepEqual(run(100, { voltage: "mid_high", metering: "hourly" }).outcomes, ["check_accuracy_voltage", "ok_below"]);
  });

  test("требования законодательства и специалист показываются всегда", () => {
    for (const kw of [10, 500, 700, 800, 25_000]) {
      const n = run(kw, {}).notes;
      for (const id of ["law_2022", "law_2024", "law_2030", "model_specialist"]) assert.ok(n.includes(id), `${kw}: ${id}`);
    }
  });
});
