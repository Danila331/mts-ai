/**
 * Движок мастеров (T7): мастер — это данные, а не код. Сценарий описывает шаги с вариантами ответа, условия
 * показа шагов, итоговые направления и оговорки; движок только ходит по описанию. Новый мастер (T19, T20) —
 * отдельный файл в `flows/` и строка в `flows/index.ts`, движок при этом не меняется.
 *
 * Чистый модуль без React и без импортов: его напрямую гоняет `node --test`.
 *
 * Ограничение №1: всё, что мастер показывает клиенту, опирается на базу знаний. У каждого шага, итога и
 * оговорки есть ссылка на раздел базы ({@link KbRef}), у итога и оговорки — дословная цитата этого раздела.
 * Общий тест `wizards.test.ts` проходит по всем сценариям из `flows/index.ts` и проверяет, что раздел есть,
 * цитата в нём есть дословно, а каждое число из текстов сценария встречается в тексте раздела.
 *
 * Мастер не считает деньги: никаких рублей, процентов экономии и окупаемости — только «какое направление
 * подходит и почему, по базе». Это тоже проверяет тест.
 */

// ---------- паспорт задачи (T2) ----------

/**
 * Поля паспорта — копия каталога Go-API (`backend/internal/passport/passport.go`, `Catalog`). Мастер пишет
 * только в эти поля; тест сверяет список с Go-кодом, чтобы PATCH не получил неизвестное поле.
 */
export const PASSPORT_KEYS = [
  "org_type",
  "object_type",
  "region",
  "task",
  "connected_power",
  "monthly_consumption",
  "metering",
  "consumption_profile",
  "voltage_class",
  "supplier",
  "price_category",
  "supply_points",
  "site_area",
  "meters",
  "collection_scheme",
  "metering_goal",
  "metering_data",
  "resource_type",
  "meter_fleet",
  "image_channel",
  "photo_volume",
  "name",
  "phone",
  "company",
  "callback_preference",
] as const;
export type PassportKey = (typeof PASSPORT_KEYS)[number];

/** Закрытый список поля `task` — как в Go (`passport.Tasks`): иначе сервер ответит 400. */
export const PASSPORT_TASKS = ["снижение платежа", "автоматизация учёта", "поиск потерь", "надёжность электроснабжения"];

/** Контакты мастер не спрашивает и не пишет: их клиент оставляет только в карточке заявки с согласием. */
export const CONTACT_KEYS: readonly PassportKey[] = ["name", "phone", "company", "callback_preference"];

// ---------- описание сценария ----------

/** Раздел базы: документ (путь от `knowledge-base/`) и заголовок раздела дословно. id раздела не зашиваем. */
export interface KbRef {
  doc: string;
  section: string;
}

/** Условие на ответы: выбран ли в шаге один из вариантов; и/или/не. Неотвеченный шаг не выполняет `is`. */
export type Condition =
  | { step: string; is: string | readonly string[] }
  | { all: readonly Condition[] }
  | { any: readonly Condition[] }
  | { not: Condition };

export interface WizardOption {
  id: string;
  label: string;
  hint?: string;
  /** Что вариант пишет в паспорт. Нет значения — вариант паспорт не трогает («Не знаю»). */
  passport?: Partial<Record<PassportKey, string>>;
}

export interface WizardStep {
  id: string;
  /** Вопрос клиенту. */
  title: string;
  /** Короткая подпись ответа в итоге и в реплике: «Тип организации». */
  label: string;
  hint?: string;
  /** Откуда варианты и формулировки шага. */
  sources: readonly KbRef[];
  options: readonly WizardOption[];
  /** Необязательное поле «уточните своими словами»: его текст идёт в паспорт вместо значения варианта. */
  input?: { passport: PassportKey; label: string; placeholder?: string };
  /** Шаг показывается, только если условие выполнено, — так задаются ветвления. */
  when?: Condition;
}

/** Направление в итоге: что обсудить и почему, с цитатой раздела базы. */
export interface WizardOutcome {
  id: string;
  /** Направление так, как его называет база. */
  title: string;
  /** Почему подходит — пересказ раздела; числа только из этого раздела. */
  why: string;
  /** Дословная цитата раздела {@link source}. */
  quote: string;
  source: KbRef;
  /** Реплика в чат по кнопке «Продолжить в чате»: вопрос про это направление. */
  ask: string;
  when?: Condition;
}

/** Оговорка: что важно знать при таких ответах (порог, «честное нет»). Показываются все подходящие. */
export interface WizardNote {
  id: string;
  text: string;
  quote: string;
  source: KbRef;
  when: Condition;
}

export interface WizardFlow {
  id: string;
  /** Название на кнопке входа. */
  title: string;
  /** Пояснение под названием. */
  subtitle: string;
  steps: readonly WizardStep[];
  /** Направления в порядке приоритета: в итог идут первые {@link maxOutcomes} подходящих. */
  outcomes: readonly WizardOutcome[];
  /** Если не подошло ни одно направление. */
  fallback: WizardOutcome;
  maxOutcomes: number;
  notes: readonly WizardNote[];
  /** Начало реплики в чат перед перечнем ответов. */
  intro: string;
  /** Реплика по кнопке «Передать менеджеру». */
  handoff: string;
}

// ---------- ответы ----------

export interface WizardAnswer {
  option: string;
  /** Текст из поля «уточните» шага, если клиент его заполнил. */
  text?: string;
}

export type WizardAnswers = Record<string, WizardAnswer>;

/** Что хранится в сессии после мастера: по ответам итог пересчитывается детерминированно. */
export interface WizardRecord {
  flow: string;
  answers: WizardAnswers;
}

// ---------- ход по шагам ----------

export function matches(cond: Condition | undefined, answers: WizardAnswers): boolean {
  if (!cond) return true;
  if ("all" in cond) return cond.all.every((c) => matches(c, answers));
  if ("any" in cond) return cond.any.some((c) => matches(c, answers));
  if ("not" in cond) return !matches(cond.not, answers);
  const picked = answers[cond.step]?.option;
  if (picked === undefined) return false;
  return typeof cond.is === "string" ? picked === cond.is : cond.is.includes(picked);
}

/**
 * Ответы только по шагам, которые при этих ответах показываются. Шаг, скрытый после правки раннего ответа,
 * перестаёт влиять на итог и паспорт. Условие шага смотрит только на ответы шагов до него.
 */
export function effectiveAnswers(flow: WizardFlow, answers: WizardAnswers): WizardAnswers {
  const out: WizardAnswers = {};
  for (const step of flow.steps) {
    if (!matches(step.when, out)) continue;
    const a = answers[step.id];
    if (a && step.options.some((o) => o.id === a.option)) out[step.id] = a;
  }
  return out;
}

/** Шаги, которые клиент увидит при этих ответах, по порядку. */
export function visibleSteps(flow: WizardFlow, answers: WizardAnswers): WizardStep[] {
  const out: WizardAnswers = {};
  const steps: WizardStep[] = [];
  for (const step of flow.steps) {
    if (!matches(step.when, out)) continue;
    steps.push(step);
    const a = answers[step.id];
    if (a) out[step.id] = a;
  }
  return steps;
}

/** Следующий неотвеченный шаг; `undefined` — мастер пройден. */
export function nextStep(flow: WizardFlow, answers: WizardAnswers): WizardStep | undefined {
  return visibleSteps(flow, answers).find((s) => !answers[s.id]);
}

/** Ответить на шаг. Ответы шагов после него сохраняются: если шаг остался виден, ответ снова пригодится. */
export function answer(answers: WizardAnswers, stepId: string, value: WizardAnswer): WizardAnswers {
  const text = value.text?.replace(/\s+/g, " ").trim();
  return { ...answers, [stepId]: text ? { option: value.option, text } : { option: value.option } };
}

/** Снять ответ (шаг «назад»). */
export function unanswer(answers: WizardAnswers, stepId: string): WizardAnswers {
  const rest = { ...answers };
  delete rest[stepId];
  return rest;
}

// ---------- итог ----------

export interface WizardResult {
  outcomes: WizardOutcome[];
  notes: WizardNote[];
  /** Ответы — подписи вопросов и выбранных вариантов, для итога и реплики в чат. */
  summary: { step: string; label: string; answer: string }[];
  passport: Partial<Record<PassportKey, string>>;
}

export function optionOf(step: WizardStep, a: WizardAnswer | undefined): WizardOption | undefined {
  return a ? step.options.find((o) => o.id === a.option) : undefined;
}

/** Значения паспорта по ответам: поле «уточните» главнее значения варианта. Контакты не пишутся никогда. */
export function passportValues(flow: WizardFlow, answers: WizardAnswers): Partial<Record<PassportKey, string>> {
  const eff = effectiveAnswers(flow, answers);
  const values: Partial<Record<PassportKey, string>> = {};
  for (const step of flow.steps) {
    const a = eff[step.id];
    const option = optionOf(step, a);
    if (!option) continue;
    Object.assign(values, option.passport);
    if (step.input && a?.text) values[step.input.passport] = a.text;
  }
  for (const key of CONTACT_KEYS) delete values[key];
  return values;
}

export function evaluate(flow: WizardFlow, answers: WizardAnswers): WizardResult {
  const eff = effectiveAnswers(flow, answers);
  const matched = flow.outcomes.filter((o) => matches(o.when, eff)).slice(0, flow.maxOutcomes);
  const summary: WizardResult["summary"] = [];
  for (const step of flow.steps) {
    const a = eff[step.id];
    const option = optionOf(step, a);
    if (!option) continue;
    summary.push({ step: step.id, label: step.label, answer: a?.text ? `${option.label} — ${a.text}` : option.label });
  }
  return {
    outcomes: matched.length ? matched : [flow.fallback],
    notes: flow.notes.filter((n) => matches(n.when, eff)),
    summary,
    passport: passportValues(flow, answers),
  };
}

/** «Промышленное предприятие» → «промышленное предприятие», но «СНТ» и «ТСЖ» остаются как есть. */
function lowerFirst(s: string): string {
  return s.length > 1 && s[1] === s[1].toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s;
}

/** Реплика клиента в чат: ответы мастера и вопрос про первое направление (или просьба передать менеджеру). */
export function chatReplica(flow: WizardFlow, answers: WizardAnswers, intent: "continue" | "handoff"): string {
  const result = evaluate(flow, answers);
  const lines = result.summary.map((s) => `${s.label}: ${lowerFirst(s.answer)}.`);
  const tail = intent === "handoff" ? flow.handoff : result.outcomes[0].ask;
  return [flow.intro, ...lines, tail].join("\n");
}

// ---------- ссылки на разделы базы ----------

interface KbDocLike {
  doc: string;
  title?: string;
  chunks: { id: string; path: string }[];
}

function findDoc<T extends KbDocLike>(docs: readonly T[] | null | undefined, doc: string): T | undefined {
  const name = doc.split("/").pop();
  return docs?.find((d) => d.doc === doc) ?? docs?.find((d) => d.doc.split("/").pop() === name);
}

/**
 * id раздела базы в ответе `GET /api/kb`. id — sha1 от текста (`energybot/kb.py`), поэтому ищем по документу
 * и заголовку: сначала раздел, чей путь заканчивается заголовком, затем первый подраздел внутри него.
 */
export function kbChunkId(docs: readonly KbDocLike[] | null | undefined, ref: KbRef): string | undefined {
  const doc = findDoc(docs, ref.doc);
  if (!doc) return undefined;
  const parts = (path: string) => path.split(" > ").map((p) => p.trim());
  return (
    doc.chunks.find((c) => parts(c.path).at(-1) === ref.section)?.id ??
    doc.chunks.find((c) => parts(c.path).includes(ref.section))?.id
  );
}

/** Ссылка на раздел в /kb; пока база не загрузилась или раздел не нашёлся — на документ. */
export function kbRefHref(docs: readonly KbDocLike[] | null | undefined, ref: KbRef): string {
  const id = kbChunkId(docs, ref);
  if (id) return `/kb?chunk=${encodeURIComponent(id)}`;
  return `/kb?doc=${encodeURIComponent(findDoc(docs, ref.doc)?.doc ?? ref.doc)}`;
}

/** Название документа для подписи ссылки. */
export function kbDocTitle(docs: readonly KbDocLike[] | null | undefined, ref: KbRef): string | undefined {
  return findDoc(docs, ref.doc)?.title;
}

// ---------- обход текстов сценария (для теста сверки с базой) ----------

/** Текст сценария, который видит клиент или который уходит в чат, и разделы базы, на которые он опирается. */
export interface FlowText {
  where: string;
  text: string;
  sources: readonly KbRef[];
}

/** Все тексты сценария с их разделами базы. Тест сверяет числа в каждом тексте с текстом этих разделов. */
export function flowTexts(flow: WizardFlow): FlowText[] {
  const out: FlowText[] = [];
  const push = (where: string, text: string | undefined, sources: readonly KbRef[]) => {
    if (text) out.push({ where, text, sources });
  };
  const all = [...flow.steps.flatMap((s) => s.sources), ...flow.outcomes.map((o) => o.source), flow.fallback.source];
  push(`${flow.id}.title`, flow.title, all);
  push(`${flow.id}.subtitle`, flow.subtitle, all);
  push(`${flow.id}.intro`, flow.intro, all);
  push(`${flow.id}.handoff`, flow.handoff, all);
  for (const step of flow.steps) {
    const at = `${flow.id}.${step.id}`;
    push(`${at}.title`, step.title, step.sources);
    push(`${at}.label`, step.label, step.sources);
    push(`${at}.hint`, step.hint, step.sources);
    push(`${at}.input.label`, step.input?.label, step.sources);
    push(`${at}.input.placeholder`, step.input?.placeholder, step.sources);
    for (const o of step.options) {
      push(`${at}.${o.id}.label`, o.label, step.sources);
      push(`${at}.${o.id}.hint`, o.hint, step.sources);
      for (const [key, value] of Object.entries(o.passport ?? {})) push(`${at}.${o.id}.passport.${key}`, value, step.sources);
    }
  }
  for (const o of [...flow.outcomes, flow.fallback]) {
    const at = `${flow.id}.${o.id}`;
    for (const field of ["title", "why", "quote", "ask"] as const) push(`${at}.${field}`, o[field], [o.source]);
  }
  for (const n of flow.notes) {
    push(`${flow.id}.${n.id}.text`, n.text, [n.source]);
    push(`${flow.id}.${n.id}.quote`, n.quote, [n.source]);
  }
  return out;
}

/** Все разделы базы, на которые ссылается сценарий. */
export function flowRefs(flow: WizardFlow): { where: string; ref: KbRef }[] {
  return [
    ...flow.steps.flatMap((s) => s.sources.map((ref) => ({ where: `${flow.id}.${s.id}`, ref }))),
    ...[...flow.outcomes, flow.fallback].map((o) => ({ where: `${flow.id}.${o.id}`, ref: o.source })),
    ...flow.notes.map((n) => ({ where: `${flow.id}.${n.id}`, ref: n.source })),
  ];
}

/** Все условия сценария — тест проверяет, что они ссылаются на существующие шаги и варианты. */
export function flowConditions(flow: WizardFlow): { where: string; cond: Condition; step?: string }[] {
  const out: { where: string; cond: Condition; step?: string }[] = [];
  for (const s of flow.steps) if (s.when) out.push({ where: `${flow.id}.${s.id}`, cond: s.when, step: s.id });
  for (const o of flow.outcomes) if (o.when) out.push({ where: `${flow.id}.${o.id}`, cond: o.when });
  for (const n of flow.notes) out.push({ where: `${flow.id}.${n.id}`, cond: n.when });
  return out;
}
