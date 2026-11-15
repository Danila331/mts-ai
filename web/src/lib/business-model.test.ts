// node --experimental-strip-types --test src/lib/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  type Inputs,
  MONEY_KEYS,
  NO_SOURCE,
  PARAMS,
  REFERENCES,
  breakEvenVerdict,
  compute,
  emptyInputs,
  runScenarios,
  scenarioValues,
  tornado,
  validate,
} from "./business-model.ts";

// Круглые числа ради проверки арифметики; в продукт они не попадают.
function filled(): Inputs {
  const i = emptyInputs();
  i.visits = { min: 800, base: 1000, max: 1200 };
  i.chatOpen = { min: 0.1, base: 0.2, max: 0.3 };
  i.leadRate = { min: 0.1, base: 0.2, max: 0.3 };
  i.targetShare = { min: 0.4, base: 0.5, max: 0.6 };
  i.dealShare = { min: 0.1, base: 0.2, max: 0.3 };
  i.callMinutes = { min: 5, base: 10, max: 15 };
  i.presaleHourCost = { min: null, base: 60, max: null };
  i.dealValue = { min: 100, base: 200, max: 300 };
  i.dialogCost = { min: 1, base: 2, max: 3 };
  i.supportCost = { min: 50, base: 100, max: 150 };
  return i;
}

describe("business-model", () => {
  test("пустой ввод ничего не считает и не придумывает", () => {
    const r = runScenarios(emptyInputs());
    for (const s of Object.values(r)) {
      assert.equal(s.net, null);
      assert.equal(s.targetLeads, null);
      assert.equal(s.breakEvenTargetLeads, null);
      assert.equal(s.missing.length, PARAMS.length);
    }
    assert.equal(tornado(emptyInputs()), null);
  });

  test("воронка и деньги в базовом сценарии", () => {
    const b = runScenarios(filled()).base;
    assert.equal(b.dialogs, 200);
    assert.equal(b.leads, 40);
    assert.equal(b.targetLeads, 20);
    assert.equal(b.deals, 4);
    assert.equal(b.dealIncome, 800);
    assert.equal(b.timeSaving, 200); // 20 × 10/60 × 60
    assert.equal(b.dialogCosts, 400);
    assert.equal(b.net, 800 + 200 - 400 - 100);
  });

  test("сценарии: у затрат пессимизм — верхний край, у выгод — нижний", () => {
    const i = filled();
    const p = scenarioValues(i, "pessimistic");
    const o = scenarioValues(i, "optimistic");
    assert.equal(p.chatOpen, 0.1);
    assert.equal(p.dialogCost, 3);
    assert.equal(p.supportCost, 150);
    assert.equal(o.chatOpen, 0.3);
    assert.equal(o.dialogCost, 1);
    const r = runScenarios(i);
    assert.ok((r.pessimistic.net as number) < (r.base.net as number));
    assert.ok((r.base.net as number) < (r.optimistic.net as number));
  });

  test("пустой край диапазона заменяется базой", () => {
    assert.equal(scenarioValues(filled(), "pessimistic").presaleHourCost, 60);
    assert.equal(scenarioValues(filled(), "optimistic").presaleHourCost, 60);
  });

  test("безубыточность: расходы / ценность одной целевой заявки", () => {
    const b = runScenarios(filled()).base;
    // ценность: 0,2 × 200 + 10/60 × 60 = 50; расходы: 400 + 100 = 500
    assert.equal(b.valuePerTargetLead, 50);
    assert.equal(b.breakEvenTargetLeads, 10);
    assert.equal(breakEvenVerdict(b), "covers"); // 20 ≥ 10
    // на точке безубыточности чистый эффект равен нулю
    const v = scenarioValues(filled(), "base");
    const factor = (b.breakEvenTargetLeads as number) / (b.targetLeads as number);
    const atBE = compute({ ...v, targetShare: (v.targetShare as number) * factor });
    assert.ok(Math.abs(atBE.net as number) < 1e-9);
  });

  test("безубыточность не считается без ценности заявки или при нулевой ценности", () => {
    const i = filled();
    i.dealValue = { min: null, base: null, max: null };
    assert.equal(runScenarios(i).base.breakEvenTargetLeads, null);
    const z = filled();
    z.dealShare = { min: 0, base: 0, max: 0 };
    z.callMinutes = { min: 0, base: 0, max: 0 };
    assert.equal(runScenarios(z).base.breakEvenTargetLeads, null);
    assert.equal(breakEvenVerdict(runScenarios(z).base), "unknown");
  });

  test("чувствительность: отсортирована по размаху, края согласованы со сценариями", () => {
    const t = tornado(filled());
    assert.ok(t);
    assert.equal(t.metric, "net");
    assert.equal(t.baseValue, runScenarios(filled()).base.net);
    for (let k = 1; k < t.bars.length; k++) assert.ok(t.bars[k - 1].swing >= t.bars[k].swing);
    const bar = t.bars.find((b) => b.key === "supportCost");
    assert.ok(bar);
    assert.equal(bar.adverse, (t.baseValue as number) - 50);
    assert.equal(bar.favorable, (t.baseValue as number) + 50);
    // параметр без диапазона даёт нулевой размах
    assert.equal(t.bars.find((b) => b.key === "presaleHourCost")?.swing, 0);
  });

  test("без денег чувствительность считается по целевым заявкам", () => {
    const i = filled();
    for (const k of MONEY_KEYS) i[k] = { min: null, base: null, max: null };
    const t = tornado(i);
    assert.ok(t);
    assert.equal(t.metric, "targetLeads");
    assert.equal(t.baseValue, 20);
    assert.ok(t.bars.every((b) => !MONEY_KEYS.includes(b.key)));
  });

  test("валидация ввода", () => {
    assert.deepEqual(validate(filled()), []);
    const bad = filled();
    bad.chatOpen = { min: 0.5, base: 0.2, max: 0.3 };
    bad.leadRate = { min: null, base: 1.5, max: null };
    bad.supportCost = { min: null, base: -1, max: null };
    const keys = validate(bad).map((e) => e.key);
    assert.deepEqual(keys.sort(), ["chatOpen", "leadRate", "supportCost"]);
  });

  test("у каждого параметра есть источник; без числового источника — пометка или внутренние данные", () => {
    for (const p of PARAMS) {
      assert.ok(p.source.length > 10, p.key);
      if (p.confidence === "none") {
        assert.ok(p.source.includes(NO_SOURCE) || p.source.includes("введите своё"), p.key);
      }
    }
  });

  test("в модуле нет «зашитых» денежных значений и валют", () => {
    const src = readFileSync(new URL("./business-model.ts", import.meta.url), "utf8");
    // Определения параметров не несут значений по умолчанию.
    for (const p of PARAMS) {
      assert.ok(!("default" in p) && !("value" in p) && !("min" in p), p.key);
    }
    for (const k of MONEY_KEYS) {
      const r = emptyInputs()[k];
      assert.deepEqual(r, { min: null, base: null, max: null });
    }
    // Нет символов валют и рублёвых слов в коде (комментарии проверяем отдельно ниже).
    const code = src.replace(/\/\/.*$/gm, "");
    assert.ok(!/[₽$€]/.test(code.replace(/\$\{/g, "")), "символ валюты в коде");
    assert.ok(!/\b(руб|тыс\.? ?руб|млн ?руб|RUB|USD)\b/i.test(code), "рублёвое слово в коде");
    // Нет числовых литералов вида 1000+ или десятичных долей присвоений параметрам.
    assert.ok(!/(visits|dealValue|dialogCost|supportCost|presaleHourCost)\s*[:=]\s*\d/.test(code));
    // «~400 тыс. компаний» не подтверждена материалами репозитория и в модель не входит.
    assert.ok(!/400/.test(code));
  });

  test("внешние опоры не входят в расчёт и подписаны оговоркой", () => {
    for (const r of REFERENCES) {
      assert.equal(r.inModel, false);
      assert.ok(r.caveat.length > 0);
    }
    const hbr = REFERENCES.find((r) => r.id === "hbr-2011");
    assert.ok(hbr?.caveat.includes("Старые данные США"));
  });
});
