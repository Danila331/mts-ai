// Бизнес-модель T41: воронка, три сценария, чувствительность, точка безубыточности.
// Чистый модуль без UI. Своих чисел здесь нет: все значения вводит пользователь, пока пилот (T40) не даст замеры.
// Деньги — только экономика МТС в единицах, которые пользователь выбирает сам; валюту и суммы по умолчанию не подставляем.

export type Confidence = "none" | "pilot" | "external";

export type ParamKey =
  | "visits"
  | "chatOpen"
  | "leadRate"
  | "targetShare"
  | "dealShare"
  | "callMinutes"
  | "presaleHourCost"
  | "dealValue"
  | "dialogCost"
  | "supportCost";

export interface ParamDef {
  key: ParamKey;
  label: string;
  unit: "count" | "share" | "minutes" | "money";
  /** benefit: больше — лучше для МТС; cost: больше — хуже. Определяет, какой край диапазона пессимистичный. */
  direction: "benefit" | "cost";
  /** Откуда возьмётся значение. Без источника — честная пометка, а не число. */
  source: string;
  confidence: Confidence;
  /** Как называется статус значения для пользователя. */
  note: string;
}

export const NO_SOURCE = "оценка команды, уточнит пилот";

export const PARAMS: ParamDef[] = [
  {
    key: "visits",
    label: "Визитов на страницы пилота в месяц",
    unit: "count",
    direction: "benefit",
    source: "веб-аналитика сайта МТС (docs/rollout.md, метрики пилота); у нас своего отслеживания посетителей нет",
    confidence: "pilot",
    note: "введите данные аналитики",
  },
  {
    key: "chatOpen",
    label: "Доля визитов, открывших чат",
    unit: "share",
    direction: "benefit",
    source: NO_SOURCE,
    confidence: "none",
    note: "источника в репозитории нет; внешние цифры вендоров виджетов не используем",
  },
  {
    key: "leadRate",
    label: "Доля открывших чат, дошедших до заявки",
    unit: "share",
    direction: "benefit",
    source: NO_SOURCE + " (воронка «сессия → заявка», T6)",
    confidence: "none",
    note: "замерит пилот",
  },
  {
    key: "targetShare",
    label: "Доля целевых среди заявок",
    unit: "share",
    direction: "benefit",
    source: NO_SOURCE + " (разметка пресейла, T5)",
    confidence: "none",
    note: "размечает пресейл МТС",
  },
  {
    key: "dealShare",
    label: "Доля сделок среди целевых заявок",
    unit: "share",
    direction: "benefit",
    source: NO_SOURCE + " (данные CRM МТС)",
    confidence: "none",
    note: "бот сделки не закрывает: это работа менеджера",
  },
  {
    key: "callMinutes",
    label: "Минут пресейла, сэкономленных на уточняющем звонке (на целевую заявку)",
    unit: "minutes",
    direction: "benefit",
    source: NO_SOURCE + " (медиана первого звонка, чат против формы; телефония или CRM МТС)",
    confidence: "none",
    note: "метрика внутренняя: клиенту срок звонка не называется",
  },
  {
    key: "presaleHourCost",
    label: "Стоимость часа пресейла для МТС",
    unit: "money",
    direction: "benefit",
    source: "внутренние данные МТС; введите своё",
    confidence: "none",
    note: "по умолчанию пусто",
  },
  {
    key: "dealValue",
    label: "Ценность одной сделки для МТС",
    unit: "money",
    direction: "benefit",
    source: "внутренние данные МТС; введите своё",
    confidence: "none",
    note: "по умолчанию пусто; расчётов экономии клиенту здесь нет",
  },
  {
    key: "dialogCost",
    label: "Стоимость одного диалога с ботом",
    unit: "money",
    direction: "cost",
    source: "уточнит пилот: токены каждого ответа в журнале — T34 (`answers.usage`), пока замеров нет",
    confidence: "pilot",
    note: "замера нет, цифру не выдумываем",
  },
  {
    key: "supportCost",
    label: "Сопровождение бота в месяц",
    unit: "money",
    direction: "cost",
    source: "внутренние данные МТС (дежурство, обновление базы знаний, контент-команда); введите своё",
    confidence: "none",
    note: "по умолчанию пусто",
  },
];

export const PARAM_KEYS: ParamKey[] = PARAMS.map((p) => p.key);
export const MONEY_KEYS: ParamKey[] = PARAMS.filter((p) => p.unit === "money").map((p) => p.key);

export interface Range {
  min: number | null;
  base: number | null;
  max: number | null;
}

export type Inputs = Record<ParamKey, Range>;

export const EMPTY_RANGE: Range = { min: null, base: null, max: null };

/** Пустая модель: ни одного значения. Заполняет пользователь. */
export function emptyInputs(): Inputs {
  const out = {} as Inputs;
  for (const k of PARAM_KEYS) out[k] = { ...EMPTY_RANGE };
  return out;
}

export type ScenarioId = "pessimistic" | "base" | "optimistic";
export const SCENARIOS: { id: ScenarioId; label: string }[] = [
  { id: "pessimistic", label: "Пессимистичный" },
  { id: "base", label: "Базовый" },
  { id: "optimistic", label: "Оптимистичный" },
];

const isNum = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Ошибки ввода: min ≤ base ≤ max, доли в [0, 1], остальное не отрицательное. */
export function validate(inputs: Inputs): { key: ParamKey; message: string }[] {
  const errors: { key: ParamKey; message: string }[] = [];
  for (const def of PARAMS) {
    const r = inputs[def.key];
    const vals = [r.min, r.base, r.max].filter(isNum);
    if (vals.some((v) => v < 0)) errors.push({ key: def.key, message: "значение не может быть отрицательным" });
    if (def.unit === "share" && vals.some((v) => v > 1)) errors.push({ key: def.key, message: "доля не больше 100%" });
    const lo = isNum(r.min) ? r.min : null;
    const hi = isNum(r.max) ? r.max : null;
    const b = isNum(r.base) ? r.base : null;
    if ((lo !== null && b !== null && lo > b) || (b !== null && hi !== null && b > hi) || (lo !== null && hi !== null && lo > hi)) {
      errors.push({ key: def.key, message: "нужно: минимум ≤ база ≤ максимум" });
    }
  }
  return errors;
}

/** Значение параметра в сценарии. Пустой край диапазона заменяется базой. null — базы нет. */
export function valueFor(def: ParamDef, r: Range, scenario: ScenarioId): number | null {
  if (!isNum(r.base)) return null;
  if (scenario === "base") return r.base;
  const low = isNum(r.min) ? r.min : r.base;
  const high = isNum(r.max) ? r.max : r.base;
  const wantHigh = (scenario === "optimistic") === (def.direction === "benefit");
  return wantHigh ? high : low;
}

export type Values = Partial<Record<ParamKey, number>>;

export function scenarioValues(inputs: Inputs, scenario: ScenarioId): Values {
  const out: Values = {};
  for (const def of PARAMS) {
    const v = valueFor(def, inputs[def.key], scenario);
    if (v !== null) out[def.key] = v;
  }
  return out;
}

export interface Result {
  dialogs: number | null;
  leads: number | null;
  targetLeads: number | null;
  deals: number | null;
  /** Ценность одной целевой заявки: доля сделок × ценность сделки + сэкономленное время пресейла. */
  valuePerTargetLead: number | null;
  dealIncome: number | null;
  timeSaving: number | null;
  dialogCosts: number | null;
  supportCost: number | null;
  /** Чистый эффект в месяц. null, пока заполнены не все денежные параметры. */
  net: number | null;
  /** Сколько целевых заявок в месяц должен добавить бот, чтобы покрыть расходы. null, если считать не из чего. */
  breakEvenTargetLeads: number | null;
  /** Параметры, которых не хватает для полного расчёта. */
  missing: ParamKey[];
}

const mul = (...xs: (number | undefined)[]): number | null => (xs.every((x) => x !== undefined) ? (xs as number[]).reduce((a, b) => a * b, 1) : null);

export function compute(v: Values): Result {
  const dialogs = mul(v.visits, v.chatOpen);
  const leads = mul(dialogs ?? undefined, v.leadRate);
  const targetLeads = mul(leads ?? undefined, v.targetShare);
  const deals = mul(targetLeads ?? undefined, v.dealShare);

  const dealIncome = mul(deals ?? undefined, v.dealValue);
  const timeSaving = mul(targetLeads ?? undefined, v.callMinutes, v.presaleHourCost) === null ? null : (targetLeads as number) * (v.callMinutes as number) / 60 * (v.presaleHourCost as number);
  const dialogCosts = mul(dialogs ?? undefined, v.dialogCost);
  const supportCost = v.supportCost ?? null;

  // Ценность целевой заявки — только из того, что задано; требуем все четыре параметра, чтобы не занижать молча.
  const valuePerTargetLead =
    v.dealShare !== undefined && v.dealValue !== undefined && v.callMinutes !== undefined && v.presaleHourCost !== undefined
      ? v.dealShare * v.dealValue + (v.callMinutes / 60) * v.presaleHourCost
      : null;

  const net =
    dealIncome !== null && timeSaving !== null && dialogCosts !== null && supportCost !== null
      ? dealIncome + timeSaving - dialogCosts - supportCost
      : null;

  // Диалоги идут от визитов и не зависят от того, дойдут ли они до заявки, поэтому расходы фиксированы.
  const fixedCosts = dialogCosts !== null && supportCost !== null ? dialogCosts + supportCost : null;
  const breakEvenTargetLeads = fixedCosts !== null && valuePerTargetLead !== null && valuePerTargetLead > 0 ? fixedCosts / valuePerTargetLead : null;

  const missing = PARAM_KEYS.filter((k) => v[k] === undefined);
  return { dialogs, leads, targetLeads, deals, valuePerTargetLead, dealIncome, timeSaving, dialogCosts, supportCost, net, breakEvenTargetLeads, missing };
}

export function runScenarios(inputs: Inputs): Record<ScenarioId, Result> {
  return {
    pessimistic: compute(scenarioValues(inputs, "pessimistic")),
    base: compute(scenarioValues(inputs, "base")),
    optimistic: compute(scenarioValues(inputs, "optimistic")),
  };
}

export interface TornadoBar {
  key: ParamKey;
  label: string;
  /** Метрика при неблагоприятном и благоприятном краях диапазона параметра (остальные — на базе). */
  adverse: number;
  favorable: number;
  swing: number;
}

export interface Tornado {
  metric: "net" | "targetLeads";
  baseValue: number;
  bars: TornadoBar[];
}

/** Чувствительность по одному параметру. Метрика — чистый эффект, а если денежные параметры не заданы, число целевых заявок. */
export function tornado(inputs: Inputs): Tornado | null {
  const base = scenarioValues(inputs, "base");
  const baseResult = compute(base);
  const metric: "net" | "targetLeads" = baseResult.net !== null ? "net" : "targetLeads";
  const pick = (r: Result) => (metric === "net" ? r.net : r.targetLeads);
  const baseValue = pick(baseResult);
  if (baseValue === null) return null;

  const bars: TornadoBar[] = [];
  for (const def of PARAMS) {
    if (metric === "targetLeads" && def.unit !== "share" && def.key !== "visits") continue;
    const r = inputs[def.key];
    if (!isNum(r.base)) continue;
    const adverseVal = valueFor(def, r, "pessimistic") as number;
    const favorableVal = valueFor(def, r, "optimistic") as number;
    const adverse = pick(compute({ ...base, [def.key]: adverseVal }));
    const favorable = pick(compute({ ...base, [def.key]: favorableVal }));
    if (adverse === null || favorable === null) continue;
    bars.push({ key: def.key, label: def.label, adverse, favorable, swing: Math.abs(favorable - adverse) });
  }
  bars.sort((a, b) => b.swing - a.swing);
  return { metric, baseValue, bars };
}

/** Окупаемость: хватает ли целевых заявок сценария для покрытия расходов. */
export function breakEvenVerdict(r: Result): "covers" | "short" | "unknown" {
  if (r.breakEvenTargetLeads === null || r.targetLeads === null) return "unknown";
  return r.targetLeads >= r.breakEvenTargetLeads ? "covers" : "short";
}

// Внешние опоры к рассказу о боли. В расчёт не входят и на конверсии не умножаются.
export interface Reference {
  id: string;
  claim: string;
  caveat: string;
  url: string;
  inModel: false;
}

export const REFERENCES: Reference[] = [
  {
    id: "hbr-2011",
    claim: "Контакт с онлайн-лидом в течение часа почти в 7 раз повышал шанс его квалифицировать; средний ответ компаний занимал 42 часа (Oldroyd и др.).",
    caveat: "Старые данные США, 2011 год. Как аргумент про скорость реакции, не как параметр модели.",
    url: "https://hbr.org/2011/03/the-short-life-of-online-sales-leads",
    inModel: false,
  },
  {
    id: "gartner-2026",
    claim: "69% B2B-покупателей перепроверяют выводы ИИ у продавца.",
    caveat: "Опрос Gartner 2026. Аргумент за схему «бот квалифицирует, человек закрывает сделку», не параметр модели.",
    url: "https://www.gartner.com/en/newsroom/press-releases/2026-05-20-gartner-survey-finds-sixty-nine-percent-of-b-two-b-buyers-turn-to-sales-reps-to-validate-ai-generated-insights",
    inModel: false,
  },
];

/** Вендорских бенчмарков конверсии в модель не берём: нет проверяемого источника в репозитории. */
export const VENDOR_BENCHMARKS_USED = 0;
