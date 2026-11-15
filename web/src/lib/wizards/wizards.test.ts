// node --experimental-strip-types --test src/lib/*.test.ts src/lib/*/*.test.ts  (npm test)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  CONTACT_KEYS,
  type Condition,
  PASSPORT_KEYS,
  PASSPORT_TASKS,
  type WizardAnswers,
  type WizardFlow,
  answer,
  chatReplica,
  effectiveAnswers,
  evaluate,
  flowConditions,
  flowRefs,
  flowTexts,
  kbChunkId,
  kbRefHref,
  nextStep,
  passportValues,
  unanswer,
  visibleSteps,
} from "./engine.ts";
import { DIAGNOSTICS, FLOWS } from "./flows/index.ts";

const KB = new URL("../../../../knowledge-base/", import.meta.url);
const PASSPORT_GO = new URL("../../../../backend/internal/passport/passport.go", import.meta.url);

/** Текст базы для сравнения: без выделения и ссылок Markdown, пробелы схлопнуты. */
const norm = (s: string) =>
  s
    .replace(/\*\*/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[\s ]+/g, " ")
    .trim();

const docCache = new Map<string, string>();
function readDoc(doc: string): string {
  if (!docCache.has(doc)) docCache.set(doc, readFileSync(new URL(doc, KB), "utf8").replace(/\r\n/g, "\n"));
  return docCache.get(doc)!;
}

/** Раздел документа: от заголовка до следующего заголовка того же или старшего уровня (с подразделами). */
function sectionText(doc: string, section: string): string | undefined {
  const lines = readDoc(doc).split("\n");
  const heading = /^(#{1,6})\s+(.*?)\s*$/;
  const start = lines.findIndex((l) => {
    const m = heading.exec(l);
    return !!m && norm(m[2]) === section;
  });
  if (start < 0) return undefined;
  const level = heading.exec(lines[start])![1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = heading.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return norm(lines.slice(start, end).join("\n"));
}

/** Число как отдельный токен: «20» не находится внутри «2025» или «20,5». */
function hasNumber(text: string, n: string): boolean {
  const variants = new Set([n, n.replace(",", "."), n.replace(".", ",")]);
  return [...variants].some((v) =>
    new RegExp(`(?<![\\d.,])${v.replace(/[.]/g, "\\.")}(?![\\d]|[.,]\\d)`).test(text),
  );
}

/** Все сочетания ответов сценария (с учётом скрытых шагов). */
function allAnswers(flow: WizardFlow, limit = 200_000): WizardAnswers[] {
  let acc: WizardAnswers[] = [{}];
  for (const step of flow.steps) {
    const next: WizardAnswers[] = [];
    for (const a of acc) {
      if (!visibleSteps(flow, a).some((s) => s.id === step.id)) next.push(a);
      else for (const o of step.options) next.push({ ...a, [step.id]: { option: o.id } });
    }
    acc = next;
    assert.ok(acc.length <= limit, `${flow.id}: слишком много сочетаний для перебора`);
  }
  return acc;
}

const MONEY = /руб|₽|%|процент|окуп|сэконом|экономи[июя]/i;

describe("ограничение №1: все мастера сверены с базой знаний", () => {
  for (const flow of FLOWS) {
    describe(`мастер «${flow.title}» (${flow.id})`, () => {
      test("каждый раздел, на который ссылается мастер, есть в базе", () => {
        for (const { where, ref } of flowRefs(flow)) {
          assert.ok(existsSync(new URL(ref.doc, KB)), `${where}: нет документа ${ref.doc}`);
          assert.ok(sectionText(ref.doc, ref.section), `${where}: в ${ref.doc} нет раздела «${ref.section}»`);
        }
      });

      test("каждая цитата есть в своём разделе дословно", () => {
        for (const o of [...flow.outcomes, flow.fallback, ...flow.notes]) {
          const section = sectionText(o.source.doc, o.source.section) ?? "";
          assert.ok(section.includes(norm(o.quote)), `${flow.id}.${o.id}: цитаты нет в «${o.source.section}»: «${o.quote}»`);
        }
      });

      test("каждое число в текстах мастера есть в тексте его разделов базы", () => {
        let checked = 0;
        for (const { where, text, sources } of flowTexts(flow)) {
          const base = sources.map((r) => sectionText(r.doc, r.section) ?? "").join("\n");
          for (const n of text.match(/\d+(?:[.,]\d+)?/g) ?? []) {
            checked++;
            assert.ok(hasNumber(base, n), `${where}: числа ${n} нет в разделах ${sources.map((r) => r.section).join(", ")}: «${text}»`);
          }
        }
        if (flow.id === DIAGNOSTICS.id) assert.ok(checked >= 10, "в диагностике должны проверяться пороги мощности");
      });

      test("никаких рублей, процентов и окупаемости", () => {
        for (const { where, text } of flowTexts(flow)) assert.ok(!MONEY.test(text), `${where}: «${text}»`);
      });

      test("мастер пишет только в поля паспорта из каталога Go-API, задачу — из списка базы, контакты — никогда", () => {
        const go = readFileSync(PASSPORT_GO, "utf8");
        const goKeys = [...go.matchAll(/Key:\s*"(\w+)"/g)].map((m) => m[1]);
        assert.deepEqual([...PASSPORT_KEYS].sort(), [...goKeys].sort(), "PASSPORT_KEYS разошёлся с passport.Catalog");
        const goTasks = [...(/var Tasks = \[\]string\{([^}]*)\}/.exec(go)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(PASSPORT_TASKS, goTasks, "PASSPORT_TASKS разошёлся с passport.Tasks");
        for (const step of flow.steps) {
          const keys = step.options.flatMap((o) => Object.keys(o.passport ?? {}));
          if (step.input) keys.push(step.input.passport);
          for (const key of keys) {
            assert.ok((PASSPORT_KEYS as readonly string[]).includes(key), `${flow.id}.${step.id}: поля ${key} нет в паспорте`);
            assert.ok(!CONTACT_KEYS.includes(key as never), `${flow.id}.${step.id}: мастер не спрашивает контакты`);
          }
          for (const o of step.options) {
            const task = o.passport?.task;
            if (task !== undefined) assert.ok(PASSPORT_TASKS.includes(task), `${flow.id}.${step.id}.${o.id}: задача «${task}»`);
            for (const v of Object.values(o.passport ?? {})) assert.ok(v.length <= 300, "предел значения поля паспорта");
          }
        }
      });

      test("условия ссылаются на существующие шаги и варианты, условие шага — только на шаги до него", () => {
        const order = flow.steps.map((s) => s.id);
        const check = (where: string, c: Condition, before?: number) => {
          if ("all" in c) return c.all.forEach((x) => check(where, x, before));
          if ("any" in c) return c.any.forEach((x) => check(where, x, before));
          if ("not" in c) return check(where, c.not, before);
          const step = flow.steps.find((s) => s.id === c.step);
          assert.ok(step, `${where}: нет шага ${c.step}`);
          if (before !== undefined) assert.ok(order.indexOf(c.step) < before, `${where}: условие на шаг ${c.step} после себя`);
          for (const id of typeof c.is === "string" ? [c.is] : c.is) {
            assert.ok(step.options.some((o) => o.id === id), `${where}: в шаге ${c.step} нет варианта ${id}`);
          }
        };
        for (const { where, cond, step } of flowConditions(flow)) check(where, cond, step ? order.indexOf(step) : undefined);
        assert.equal(new Set(order).size, order.length, "id шагов уникальны");
        for (const s of flow.steps) assert.equal(new Set(s.options.map((o) => o.id)).size, s.options.length, `${s.id}: id вариантов`);
        const ids = [...flow.outcomes, flow.fallback, ...flow.notes].map((o) => o.id);
        assert.equal(new Set(ids).size, ids.length, "id итогов и оговорок уникальны");
      });

      test("на любых ответах итог непустой и не длиннее предела; каждый итог и оговорка достижимы", () => {
        const seen = new Set<string>();
        for (const a of allAnswers(flow)) {
          assert.equal(nextStep(flow, a), undefined);
          const r = evaluate(flow, a);
          assert.ok(r.outcomes.length >= 1 && r.outcomes.length <= flow.maxOutcomes);
          for (const o of [...r.outcomes, ...r.notes]) seen.add(o.id);
        }
        for (const o of [...flow.outcomes, ...flow.notes]) assert.ok(seen.has(o.id), `${flow.id}.${o.id} недостижим`);
      });
    });
  }
});

// ---------- «Подобрать решение» ----------

/** Ответы по id вариантов: { org: "industry", task: "cost", … }. */
function pick(choices: Record<string, string>, text: Record<string, string> = {}): WizardAnswers {
  let a: WizardAnswers = {};
  for (const [step, option] of Object.entries(choices)) a = answer(a, step, { option, text: text[step] });
  return a;
}

const outcomeIds = (a: WizardAnswers) => evaluate(DIAGNOSTICS, a).outcomes.map((o) => o.id);
const noteIds = (a: WizardAnswers) => evaluate(DIAGNOSTICS, a).notes.map((n) => n.id);

describe("«Подобрать решение»: итог по таблицам базы", () => {
  const cases: [string, Record<string, string>, string[], string[]][] = [
    // [что проверяем, ответы, направления, оговорки]
    [
      "завод от 750 кВт до 20 МВт → опт через сбытовую компанию",
      { org: "industry", task: "cost", power: "from750", metering: "remote", region: "other" },
      ["orem_supplier", "price_category"],
      ["hourly"],
    ],
    [
      "завод от 20 МВт → прямое участие",
      { org: "industry", task: "cost", power: "from20", metering: "remote", region: "other" },
      ["orem_direct", "price_category"],
      ["hourly"],
    ],
    [
      "завод ниже 670 кВт → опт невозможен, ценовая категория и солнце",
      { org: "industry", task: "cost", power: "lt670", metering: "manual", region: "other" },
      ["price_category", "solar"],
      ["below750"],
    ],
    [
      "670–750 кВт — почасовой учёт обязателен, но опт ещё недоступен",
      { org: "industry", task: "cost", power: "from670", metering: "remote", region: "other" },
      ["price_category", "solar"],
      ["below750", "hourly"],
    ],
    [
      "изолированная энергосистема → опта нет даже от 750 кВт",
      { org: "industry", task: "cost", power: "from750", metering: "remote", region: "isolated" },
      ["price_category"],
      ["isolated", "hourly"],
    ],
    [
      "торговый центр от 750 кВт → опт не подходит торговле",
      { org: "commercial", task: "cost", power: "from750", metering: "remote", region: "other" },
      ["price_category", "solar"],
      ["trade", "hourly"],
    ],
    [
      "сетевая компания, потери, ручной сбор → поиск потерь и фото",
      { org: "grid", task: "losses", metering: "manual", region: "other" },
      ["losses", "photo"],
      [],
    ],
    [
      "сбытовая компания, потери → «честное нет» и учёт",
      { org: "sales", task: "losses", metering: "manual", region: "other" },
      ["photo", "platform"],
      ["losses_sales"],
    ],
    [
      "завод ищет потери → не тот продукт, платформа учёта",
      { org: "industry", task: "losses", metering: "remote", region: "other" },
      ["platform"],
      ["losses_industry"],
    ],
    [
      "склад, надёжность, мощность неизвестна → гибридная станция",
      { org: "warehouse", task: "reliability", power: "unknown", metering: "unknown", region: "other" },
      ["hybrid"],
      ["power_unknown"],
    ],
    [
      "СНТ, автоматизация, ручной сбор → фото и платформа",
      { org: "housing", task: "metering", power: "lt670", metering: "manual", region: "other" },
      ["photo", "platform"],
      [],
    ],
    [
      "сетевая компания хочет снизить платёж → специалист",
      { org: "grid", task: "cost", metering: "remote", region: "other" },
      ["specialist"],
      [],
    ],
  ];
  for (const [name, choices, outcomes, notes] of cases) {
    test(name, () => {
      const a = pick(choices);
      assert.equal(nextStep(DIAGNOSTICS, a), undefined, "мастер пройден");
      assert.deepEqual(outcomeIds(a), outcomes);
      assert.deepEqual(noteIds(a), notes);
    });
  }

  test("опт никогда не предлагается ниже 750 кВт, при неизвестной мощности и в изолированных энергосистемах", () => {
    for (const a of allAnswers(DIAGNOSTICS)) {
      const ids = outcomeIds(a);
      if (!ids.some((id) => id.startsWith("orem"))) continue;
      assert.ok(["from750", "from20"].includes(a.power?.option ?? ""), JSON.stringify(a));
      assert.notEqual(a.region?.option, "isolated");
    }
  });

  test("поиск потерь предлагается только электросетевой компании", () => {
    for (const a of allAnswers(DIAGNOSTICS)) {
      if (outcomeIds(a).includes("losses")) assert.equal(a.org.option, "grid");
    }
  });
});

describe("движок: шаги, ветвления, паспорт", () => {
  test("пять шагов по порядку, для сетевой компании шаг мощности пропускается", () => {
    let a: WizardAnswers = {};
    assert.equal(nextStep(DIAGNOSTICS, a)?.id, "org");
    a = answer(a, "org", { option: "industry" });
    assert.equal(nextStep(DIAGNOSTICS, a)?.id, "task");
    a = answer(a, "task", { option: "cost" });
    assert.deepEqual(visibleSteps(DIAGNOSTICS, a).map((s) => s.id), ["org", "task", "power", "metering", "region"]);
    const grid = pick({ org: "grid", task: "cost" });
    assert.deepEqual(visibleSteps(DIAGNOSTICS, grid).map((s) => s.id), ["org", "task", "metering", "region"]);
  });

  test("правка раннего ответа скрывает шаг — его ответ больше не влияет ни на итог, ни на паспорт", () => {
    let a = pick({ org: "industry", task: "cost", power: "from750", metering: "remote", region: "other" });
    assert.equal(passportValues(DIAGNOSTICS, a).connected_power, "от 750 кВт, но менее 20 МВт");
    a = answer(a, "org", { option: "grid" });
    assert.equal(effectiveAnswers(DIAGNOSTICS, a).power, undefined);
    assert.equal(passportValues(DIAGNOSTICS, a).connected_power, undefined);
    assert.ok(!outcomeIds(a).some((id) => id.startsWith("orem")));
    // Вернули тип организации — ответ про мощность снова в силе.
    a = answer(a, "org", { option: "industry" });
    assert.equal(outcomeIds(a)[0], "orem_supplier");
  });

  test("назад: снятый ответ — снова текущий шаг", () => {
    const a = pick({ org: "industry", task: "cost" });
    assert.equal(nextStep(DIAGNOSTICS, unanswer(a, "task"))?.id, "task");
  });

  test("паспорт: значения вариантов, уточнение региона главнее варианта, «не знаю» ничего не пишет", () => {
    const a = pick(
      { org: "warehouse", task: "cost", power: "unknown", metering: "manual", region: "other" },
      { region: "  Краснодарский   край " },
    );
    assert.deepEqual(passportValues(DIAGNOSTICS, a), {
      org_type: "склад, складской комплекс",
      object_type: "склад, складской комплекс",
      task: "снижение платежа",
      metering: "вручную: обходы контролёров, звонки абонентов, ручной ввод",
      region: "Краснодарский край",
    });
    const isolated = pick({ org: "industry", task: "cost", power: "lt670", metering: "remote", region: "isolated" });
    assert.match(passportValues(DIAGNOSTICS, isolated).region ?? "", /изолированная энергосистема/);
  });

  test("реплика в чат: ответы мастера и вопрос про первое направление или просьба передать менеджеру", () => {
    const a = pick(
      { org: "housing", task: "metering", power: "lt670", metering: "manual", region: "other" },
      { region: "Краснодарский край" },
    );
    const text = chatReplica(DIAGNOSTICS, a, "continue");
    assert.match(text, /^Прошёл подбор решения\./);
    assert.match(text, /Тип организации: управляющая компания, ТСЖ, СНТ, товарищество\./);
    assert.match(text, /Присоединённая мощность: ниже 670 кВт\./);
    assert.match(text, /Регион: другой регион России — Краснодарский край\./);
    assert.ok(text.endsWith(evaluate(DIAGNOSTICS, a).outcomes[0].ask));
    assert.ok(chatReplica(DIAGNOSTICS, a, "handoff").endsWith(DIAGNOSTICS.handoff));
  });

  test("ссылка на раздел базы: id из ответа /api/kb, а не зашитый; без базы — ссылка на документ", () => {
    const docs = [
      {
        doc: "20-products/21-orem.md",
        title: "Выход на оптовый рынок",
        chunks: [
          { id: "aaa", path: "Что это" },
          { id: "bbb", path: "Кому подходит > Порог доступа определяется присоединённой мощностью" },
        ],
      },
      { doc: "20-products/22-askue.md", chunks: [{ id: "ccc", path: "Кому подходит > Не подходит, если" }] },
    ];
    const ref = { doc: "20-products/21-orem.md", section: "Порог доступа определяется присоединённой мощностью" };
    assert.equal(kbChunkId(docs, ref), "bbb");
    assert.equal(kbRefHref(docs, ref), "/kb?chunk=bbb");
    // У раздела нет своего текста — первый подраздел.
    assert.equal(kbChunkId(docs, { doc: "20-products/22-askue.md", section: "Кому подходит" }), "ccc");
    assert.equal(kbRefHref(null, ref), `/kb?doc=${encodeURIComponent(ref.doc)}`);
  });
});
