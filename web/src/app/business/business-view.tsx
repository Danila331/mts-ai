"use client";

import { Scale } from "lucide-react";
import { useMemo, useState } from "react";
import { AppShell, PageBar } from "@/components/app-shell";
import {
  type Confidence,
  type Inputs,
  PARAMS,
  type ParamDef,
  type ParamKey,
  REFERENCES,
  type Result,
  SCENARIOS,
  breakEvenVerdict,
  emptyInputs,
  runScenarios,
  tornado,
  validate,
} from "@/lib/business-model";
import { cn } from "@/lib/utils";

type Field = "min" | "base" | "max";
type Draft = Record<ParamKey, Record<Field, string>>;

const blankDraft = (): Draft => Object.fromEntries(PARAMS.map((p) => [p.key, { min: "", base: "", max: "" }])) as Draft;

// Иллюстрация механики расчёта, а не оценка: круглые числа, деньги в условных единицах пользователя.
// Загружается только по кнопке и помечается на странице.
const EXAMPLE: Record<ParamKey, [string, string, string]> = {
  visits: ["800", "1000", "1200"],
  chatOpen: ["10", "20", "30"],
  leadRate: ["10", "20", "30"],
  targetShare: ["40", "50", "60"],
  dealShare: ["10", "20", "30"],
  callMinutes: ["5", "10", "15"],
  presaleHourCost: ["", "60", ""],
  dealValue: ["100", "200", "300"],
  dialogCost: ["1", "2", "3"],
  supportCost: ["50", "100", "150"],
};

function toInputs(d: Draft): Inputs {
  const out = emptyInputs();
  for (const p of PARAMS) {
    const conv = (s: string) => {
      const t = s.trim().replace(",", ".");
      if (t === "") return null;
      const n = Number(t);
      if (!Number.isFinite(n)) return null;
      return p.unit === "share" ? n / 100 : n;
    };
    out[p.key] = { min: conv(d[p.key].min), base: conv(d[p.key].base), max: conv(d[p.key].max) };
  }
  return out;
}

const nf = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const fmt = (v: number | null) => (v === null ? "—" : nf.format(v));

const CONF: Record<Confidence, { label: string; cls: string }> = {
  none: { label: "нет источника", cls: "bg-warning-soft text-tone-warning" },
  pilot: { label: "даст пилот", cls: "bg-info-soft text-tone-info" },
  external: { label: "внешний источник", cls: "bg-muted text-muted-foreground" },
};

const UNIT_HINT: Record<ParamDef["unit"], string> = { count: "шт.", share: "%", minutes: "мин", money: "ваши ед." };

export function BusinessView() {
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [example, setExample] = useState(false);

  const inputs = useMemo(() => toInputs(draft), [draft]);
  const errors = useMemo(() => validate(inputs), [inputs]);
  const valid = errors.length === 0;
  const results = useMemo(() => runScenarios(inputs), [inputs]);
  const torn = useMemo(() => (valid ? tornado(inputs) : null), [inputs, valid]);

  const set = (key: ParamKey, field: Field, value: string) =>
    setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value } }));

  const loadExample = () => {
    const d = blankDraft();
    for (const p of PARAMS) {
      const [min, base, max] = EXAMPLE[p.key];
      d[p.key] = { min, base, max };
    }
    setDraft(d);
    setExample(true);
  };
  const clear = () => {
    setDraft(blankDraft());
    setExample(false);
  };

  const base = results.base;

  return (
    <AppShell>
      <PageBar icon={Scale} title="Бизнес-кейс" subtitle="модель воронки без выдуманных цифр" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[980px] space-y-8 px-5 pt-4 pb-32 sm:px-6">
          <section className="space-y-2 text-[14px] leading-relaxed">
            <p>
              Модель показывает, как визиты превращаются в целевые заявки и во что это обходится МТС. Своих чисел в ней нет: каждое
              значение вводите вы, а реальные данные даст пилот (<code className="font-mono text-[13px]">docs/rollout.md</code>, метрики пилота).
              Деньги здесь только экономика МТС в ваших единицах. Расчётов экономии клиенту и тарифов нет.
            </p>
            <p className="text-muted-foreground">
              Объём рынка (число компаний) в модель не входит и на конверсии не умножается. Вендорских бенчмарков конверсии мы не берём:
              проверяемого источника в репозитории нет.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" onClick={loadExample} className="h-8 rounded-lg border border-input px-3 text-[13px] hover:bg-muted">
                Показать механику на примере
              </button>
              <button type="button" onClick={clear} className="h-8 rounded-lg border border-input px-3 text-[13px] hover:bg-muted">
                Очистить
              </button>
            </div>
            {example && (
              <p role="status" className="rounded-lg bg-warning-soft px-3 py-2 text-[13px] text-tone-warning">
                Загружен пример механики: круглые числа и условные денежные единицы, это не оценка и не прогноз. Замените своими или очистите.
              </p>
            )}
          </section>

          <section aria-labelledby="assumptions" className="space-y-3">
            <h2 id="assumptions" className="text-[16px] font-semibold">Допущения: диапазон, источник, уверенность</h2>
            <p className="text-[13px] text-muted-foreground">
              Минимум и максимум можно не заполнять: тогда берётся база. Доли вводятся в процентах.
            </p>
            <div className="overflow-x-auto rounded-xl ring-1 ring-border">
              {/* Без принудительной ширины 760 px: на экране с сайдбаром и отладкой колонка источников обрезалась (QA).
                  Ширины колонок заданы, источник переносится по словам, поля ввода сжимаются. */}
              <table className="w-full min-w-[620px] table-fixed border-collapse text-left text-[13px]">
                <colgroup>
                  <col className="w-[26%]" />
                  <col className="w-[13%]" />
                  <col className="w-[13%]" />
                  <col className="w-[13%]" />
                  <col className="w-[35%]" />
                </colgroup>
                <thead className="bg-surface text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Параметр</th>
                    <th className="px-2 py-2 font-medium">Минимум</th>
                    <th className="px-2 py-2 font-medium">База</th>
                    <th className="px-2 py-2 font-medium">Максимум</th>
                    <th className="px-3 py-2 font-medium">Источник и уверенность</th>
                  </tr>
                </thead>
                <tbody>
                  {PARAMS.map((p) => {
                    const err = errors.find((e) => e.key === p.key);
                    return (
                      <tr key={p.key} className="border-t border-border align-top">
                        <td className="px-3 py-2">
                          <div className="font-medium">{p.label}</div>
                          <div className="text-[12px] text-muted-foreground">
                            {p.unit === "money" ? "деньги МТС, " : ""}{UNIT_HINT[p.unit]}; {p.direction === "cost" ? "чем больше, тем хуже" : "чем больше, тем лучше"}
                          </div>
                          {err && <div role="alert" className="text-[12px] text-tone-danger">{err.message}</div>}
                        </td>
                        {(["min", "base", "max"] as Field[]).map((f) => (
                          <td key={f} className="px-2 py-2">
                            <input
                              type="text"
                              inputMode="decimal"
                              aria-label={`${p.label}: ${f === "min" ? "минимум" : f === "base" ? "база" : "максимум"}`}
                              placeholder={p.unit === "money" ? "введите своё" : "—"}
                              value={draft[p.key][f]}
                              onChange={(e) => {
                                set(p.key, f, e.target.value);
                              }}
                              className="h-8 w-full min-w-0 rounded-md border border-input bg-field px-2 text-[13px]"
                            />
                          </td>
                        ))}
                        <td className="px-3 py-2">
                          <span className={cn("mb-1 inline-flex h-5 items-center rounded-md px-1.5 text-[11.5px] font-medium", CONF[p.confidence].cls)}>
                            {CONF[p.confidence].label}
                          </span>
                          <div>{p.source}</div>
                          <div className="text-[12px] text-muted-foreground">{p.note}</div>
                          {p.unit === "share" && (
                            <input
                              type="range"
                              min={0}
                              max={100}
                              step={1}
                              aria-label={`${p.label}: ползунок базы`}
                              value={draft[p.key].base === "" ? 0 : Number(draft[p.key].base.replace(",", ".")) || 0}
                              onChange={(e) => {
                                set(p.key, "base", e.target.value);
                              }}
                              className="mt-1 w-full max-w-[220px] accent-primary"
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="scenarios" className="space-y-3">
            <h2 id="scenarios" className="text-[16px] font-semibold">Три сценария</h2>
            {!valid ? (
              <p className="text-[13px] text-tone-danger">Исправьте ошибки в допущениях, расчёт остановлен.</p>
            ) : (
              <div className="overflow-x-auto rounded-xl ring-1 ring-border">
                <table className="w-full min-w-[560px] border-collapse text-left text-[13px]">
                  <thead className="bg-surface text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">В месяц</th>
                      {SCENARIOS.map((s) => (
                        <th key={s.id} className="px-3 py-2 font-medium">{s.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ROWS.map((row) => (
                      <tr key={row.label} className="border-t border-border">
                        <td className="px-3 py-2">{row.label}</td>
                        {SCENARIOS.map((s) => (
                          <td key={s.id} className="px-3 py-2 font-mono tabular-nums">{fmt(row.get(results[s.id]))}</td>
                        ))}
                      </tr>
                    ))}
                    <tr className="border-t border-border bg-surface">
                      <td className="px-3 py-2 font-medium">Хватает ли целевых заявок</td>
                      {SCENARIOS.map((s) => (
                        <td key={s.id} className="px-3 py-2">{VERDICT[breakEvenVerdict(results[s.id])]}</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            {valid && base.missing.length > 0 && (
              <p className="text-[13px] text-muted-foreground">
                Прочерк значит, что не хватает данных. Для полного расчёта нужны: {base.missing.map((k) => PARAMS.find((p) => p.key === k)?.label).join("; ")}.
              </p>
            )}
          </section>

          <section aria-labelledby="breakeven" className="space-y-2">
            <h2 id="breakeven" className="text-[16px] font-semibold">Точка безубыточности</h2>
            {valid && base.breakEvenTargetLeads !== null ? (
              <div className="rounded-xl bg-surface p-4 ring-1 ring-border">
                <p className="text-[15px]">
                  Бот окупается, если добавит <span className="font-mono text-[20px] font-medium">{fmt(base.breakEvenTargetLeads)}</span>{" "}
                  целевых заявок в месяц.
                </p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Расходы (диалоги и сопровождение) делятся на ценность одной целевой заявки: доля сделок × ценность сделки плюс сэкономленное время
                  пресейла. Расходы на диалоги не зависят от того, дошёл ли диалог до заявки. Диапазон по сценариям:{" "}
                  {fmt(results.optimistic.breakEvenTargetLeads)} (оптимистичный) – {fmt(results.pessimistic.breakEvenTargetLeads)} (пессимистичный).
                  Число целевых заявок в воронке сверху оценки добавленных: часть могла бы прийти через форму и без бота.
                </p>
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                Нужны значения базы для: доли сделок, ценности сделки, минут и стоимости часа пресейла, стоимости диалога, сопровождения, визитов и долей
                воронки. Стоимость диалога пока неизвестна: замеров <code className="font-mono">usage</code> нет, цифру покажет пилот.
              </p>
            )}
          </section>

          <section aria-labelledby="tornado" className="space-y-2">
            <h2 id="tornado" className="text-[16px] font-semibold">Чувствительность</h2>
            {torn ? <Tornado data={torn} /> : <p className="text-[13px] text-muted-foreground">Появится, когда заполнена база воронки.</p>}
          </section>

          <section aria-labelledby="refs" className="space-y-2">
            <h2 id="refs" className="text-[16px] font-semibold">Внешние опоры к рассказу о боли (в расчёт не входят)</h2>
            <ul className="space-y-2 text-[13px]">
              {REFERENCES.map((r) => (
                <li key={r.id} className="rounded-lg bg-surface p-3 ring-1 ring-border">
                  <p>{r.claim}</p>
                  <p className="text-muted-foreground">{r.caveat}</p>
                  <a href={r.url} className="text-brand-text underline" target="_blank" rel="noreferrer">источник</a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

const ROWS: { label: string; get: (r: Result) => number | null }[] = [
  { label: "Диалогов", get: (r) => r.dialogs },
  { label: "Заявок", get: (r) => r.leads },
  { label: "Целевых заявок", get: (r) => r.targetLeads },
  { label: "Сделок", get: (r) => r.deals },
  { label: "Ценность сделок", get: (r) => r.dealIncome },
  { label: "Экономия времени пресейла", get: (r) => r.timeSaving },
  { label: "Стоимость диалогов", get: (r) => r.dialogCosts },
  { label: "Сопровождение", get: (r) => r.supportCost },
  { label: "Чистый эффект", get: (r) => r.net },
  { label: "Нужно целевых заявок для безубыточности", get: (r) => r.breakEvenTargetLeads },
];

const VERDICT = { covers: "да, перекрывает", short: "нет, не хватает", unknown: "—" } as const;

function Tornado({ data }: { data: NonNullable<ReturnType<typeof tornado>> }) {
  const unit = data.metric === "net" ? "чистый эффект в месяц, ваши ед." : "целевых заявок в месяц";
  const maxDelta = Math.max(1e-9, ...data.bars.flatMap((b) => [Math.abs(b.adverse - data.baseValue), Math.abs(b.favorable - data.baseValue)]));
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-muted-foreground">
        Метрика: {unit}. База: <span className="font-mono">{fmt(data.baseValue)}</span>. Каждый параметр двигается по своему диапазону, остальные стоят на базе.
        Левая полоса неблагоприятный край, правая благоприятный.
      </p>
      <ul className="space-y-1.5">
        {data.bars.map((b) => {
          const a = b.adverse - data.baseValue;
          const f = b.favorable - data.baseValue;
          return (
            <li key={b.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3 text-[12.5px]">
              <span className="truncate" title={b.label}>{b.label}</span>
              <div className="flex items-center gap-1">
                <span className="w-16 text-right font-mono tabular-nums text-muted-foreground">{fmt(b.adverse)}</span>
                <div className="relative h-4 flex-1" role="img" aria-label={`${b.label}: от ${fmt(b.adverse)} до ${fmt(b.favorable)}`}>
                  <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                  <div className="absolute inset-y-0 rounded-l bg-tone-danger/70" style={{ right: "50%", width: `${(Math.abs(Math.min(a, 0)) / maxDelta) * 50}%` }} />
                  <div className="absolute inset-y-0 rounded-r bg-tone-success/70" style={{ left: "50%", width: `${(Math.max(f, 0) / maxDelta) * 50}%` }} />
                </div>
                <span className="w-16 font-mono tabular-nums text-muted-foreground">{fmt(b.favorable)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
