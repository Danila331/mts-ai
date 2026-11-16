// node --experimental-strip-types --test src/lib/*.test.ts src/lib/*/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type WizardAnswers, answer, evaluate, nextStep } from "./engine.ts";
import { BILL_GROWTH, FLOWS, PRICE_NAVIGATOR } from "./flows/index.ts";

function pick(choices: Record<string, string>): WizardAnswers {
  let a: WizardAnswers = {};
  for (const [step, option] of Object.entries(choices)) a = answer(a, step, { option });
  return a;
}
const ids = (flow: typeof BILL_GROWTH, a: WizardAnswers) => evaluate(flow, a).outcomes.map((o) => o.id);

describe("мастера МСБ (T19) подключены и дают итог по разделам базы", () => {
  test("оба мастера в реестре", () => {
    assert.ok(FLOWS.includes(BILL_GROWTH) && FLOWS.includes(PRICE_NAVIGATOR));
  });

  test("«Почему вырос счёт»: сначала сравнить периоды, затем причина и категория", () => {
    const a = pick({ what: "volume", compare: "no", category: "unknown" });
    assert.equal(nextStep(BILL_GROWTH, a), undefined);
    assert.deepEqual(ids(BILL_GROWTH, a), ["compare_first", "volume", "category_unknown"]);
    const b = pick({ what: "unknown", compare: "yes", category: "known" });
    assert.deepEqual(ids(BILL_GROWTH, b), ["send_invoices"]);
    assert.ok(evaluate(BILL_GROWTH, b).notes.some((n) => n.id === "specialist"));
  });

  test("«Навигатор»: категория по умолчанию и обязанность уходить зависят от порога 670 кВт", () => {
    assert.deepEqual(ids(PRICE_NAVIGATOR, pick({ topic: "default", power: "lt670" })), ["default_lt"]);
    assert.deepEqual(ids(PRICE_NAVIGATOR, pick({ topic: "default", power: "from670" })), ["default_ge"]);
    assert.deepEqual(ids(PRICE_NAVIGATOR, pick({ topic: "forced", power: "from670" })), ["forced_yes"]);
    assert.deepEqual(ids(PRICE_NAVIGATOR, pick({ topic: "forced", power: "lt670" })), ["forced_no"]);
  });

  test("«Навигатор»: смена категории — по таблице учёта из раздела «Что нужно, чтобы сменить категорию»", () => {
    const run = (target: string, current: string) =>
      ids(PRICE_NAVIGATOR, pick({ topic: "switch", target, current }));
    assert.deepEqual(run("c36", "hourly"), ["switch_ready", "switch_prepare"]);
    assert.deepEqual(run("c36", "single"), ["switch_need_hourly", "switch_prepare"]);
    assert.deepEqual(run("second", "single"), ["switch_need_zonal", "switch_prepare"]);
    assert.deepEqual(run("second", "zonal"), ["switch_no_meter_change", "switch_prepare"]);
    assert.deepEqual(run("c36", "unknown"), ["switch_check_meter", "switch_prepare"]);
  });
});
