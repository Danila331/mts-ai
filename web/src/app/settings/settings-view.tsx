"use client";

import { AlertCircle, ChevronDown, Loader2, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell, PageBar } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getSettings, resetSettings, saveSettings } from "@/lib/api";
import type { RagSettings, SettingField, SettingValue } from "@/lib/types";

/** Подписи и пояснения — на фронте: ядро отдаёт только ключи, типы и пределы. */
const COPY: Record<string, { label: string; hint: string; off?: string }> = {
  top_k: { label: "Фрагментов в контексте", hint: "Сколько найденных разделов, помимо документов целиком, получит модель." },
  n_candidates: { label: "Кандидатов для реранкера", hint: "Сколько разделов поиск передаёт на переранжирование." },
  full_docs: { label: "Документов целиком", hint: "Самые релевантные документы уходят модели полностью." },
  context_chars: { label: "Бюджет контекста", hint: "Предел материалов в промпте, в символах." },
  use_dense: {
    label: "Поиск по эмбеддингам",
    hint: "Смысловой канал bge-m3 вместе с BM25, слияние RRF.",
    off: "Индекс эмбеддингов не построен",
  },
  use_reranker: { label: "Реранкер", hint: "Переранжирует кандидатов моделью-реранкером.", off: "Модель не настроена" },
  use_reference: {
    label: "Справочник в промпте",
    hint: "Справочные разделы базы всегда идут в начало промпта.",
    off: "Справочника нет в базе",
  },
  search: { label: "Схема поиска", hint: "Как из выдачи собираются материалы для модели." },
  style: { label: "Стиль ответа", hint: "Набор правил промпта." },
  use_examples: { label: "Примеры-эталоны", hint: "Показывать модели образцы ответов." },
  near: { label: "Ближайших эталонов перед вопросом", hint: "Повторить похожие эталоны прямо перед вопросом; 0 — нет." },
  temperature: { label: "Температура", hint: "0 — самые предсказуемые ответы." },
  max_tokens: { label: "Лимит токенов ответа", hint: "Сколько модель может написать за раз." },
  think: { label: "Размышления модели", hint: "Точнее на сложных вопросах, но ответ дольше." },
  refine: { label: "Сверка с базой", hint: "Второй проход: черновик ответа сверяется с базой." },
  check_kb: { label: "Проверка «есть ли в базе»", hint: "Перед ответом выяснить, есть ли в базе то, о чём спросили." },
};

const OPTION_LABELS: Record<string, Record<string, string>> = {
  search: { v3: "v3 — документы целиком", ve: "ve — фрагменты и соседние разделы" },
  style: {
    tight: "Коротко, как эталон",
    full: "С упором на полноту",
    recipe: "Рецепт эталона",
    jury: "Как у жюри",
    jury2: "Как у жюри, итерация 2",
  },
  check_kb: { "0": "Выключена", "1": "Отдельным запросом", "2": "В том же запросе" },
};

const GROUPS = [
  { key: "search", title: "Поиск" },
  { key: "generation", title: "Генерация" },
] as const;

type Draft = Record<string, SettingValue | string>;

const show = (f: SettingField, v: SettingValue | undefined) => {
  if (typeof v === "boolean") return v ? "вкл." : "выкл.";
  const named = OPTION_LABELS[f.key]?.[String(v)];
  if (named) return named;
  return typeof v === "number" ? v.toLocaleString("ru") : String(v ?? "—");
};

/** Число из поля ввода: пустое и вне пределов — ошибка, её показываем под строкой. */
function parse(f: SettingField, raw: SettingValue | string): { value?: SettingValue; error?: string } {
  if (f.kind === "bool") return { value: raw as boolean };
  if (f.kind === "enum") {
    const option = f.options?.find((o) => String(o) === String(raw));
    return option === undefined ? { error: "Нет такого варианта" } : { value: option };
  }
  const text = String(raw).replace(",", ".").trim();
  const n = Number(text);
  if (!text || !Number.isFinite(n)) return { error: "Нужно число" };
  if (f.kind === "int" && !Number.isInteger(n)) return { error: "Нужно целое число" };
  if (n < (f.min ?? -Infinity) || n > (f.max ?? Infinity)) {
    return { error: `От ${f.min?.toLocaleString("ru")} до ${f.max?.toLocaleString("ru")}` };
  }
  return { value: n };
}

function Control({
  field,
  value,
  invalid,
  onChange,
}: {
  field: SettingField;
  value: SettingValue | string;
  invalid?: boolean;
  onChange: (v: SettingValue | string) => void;
}) {
  const copy = COPY[field.key];
  const id = `s-${field.key}`;
  if (field.kind === "bool") {
    return (
      <Switch
        id={id}
        checked={Boolean(value)}
        onCheckedChange={(v) => onChange(v)}
        disabled={!field.available}
        aria-label={copy?.label ?? field.key}
      />
    );
  }
  if (field.kind === "enum") {
    return (
      <span className="relative inline-flex">
        <select
          id={id}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-[15.5rem] max-w-full appearance-none truncate rounded-lg border border-input bg-background pr-8 pl-3 text-[13.5px] outline-none transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {field.options?.map((o) => (
            <option key={String(o)} value={String(o)}>
              {OPTION_LABELS[field.key]?.[String(o)] ?? String(o)}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      </span>
    );
  }
  return (
    <input
        id={id}
        inputMode={field.kind === "float" ? "decimal" : "numeric"}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        className="tnum h-8 w-24 rounded-lg border border-input bg-background px-3 text-right text-[13.5px] outline-none transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
    />
  );
}

function Row({
  field,
  draft,
  saved,
  envValue,
  onChange,
}: {
  field: SettingField;
  draft: SettingValue | string;
  saved: SettingValue;
  envValue: SettingValue;
  onChange: (v: SettingValue | string) => void;
}) {
  const copy = COPY[field.key] ?? { label: field.key, hint: "" };
  const { value, error } = parse(field, draft);
  const dirty = value !== undefined && value !== saved;
  const offEnv = value !== undefined && value !== envValue;

  return (
    <li className="group/row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 py-3.5">
      <div className="min-w-0">
        <label htmlFor={`s-${field.key}`} className="flex items-center gap-2 text-[14px] font-medium">
          {copy.label}
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-label="не сохранено" />}
        </label>
        <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
          {field.available ? copy.hint : (copy.off ?? copy.hint)}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-[11.5px] text-muted-foreground/80">
          <span>{field.env}</span>
          {offEnv && (
            <>
              <span aria-hidden>·</span>
              <span className="font-sans">в окружении: {show(field, envValue)}</span>
              <button
                type="button"
                onClick={() => onChange(field.kind === "int" || field.kind === "float" ? String(envValue) : envValue)}
                className="inline-flex items-center gap-1 rounded font-sans text-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
              >
                <RotateCcw className="size-3" /> вернуть
              </button>
            </>
          )}
        </p>
      </div>
      <div className="flex justify-end">
        <Control field={field} value={draft} invalid={!!error} onChange={onChange} />
      </div>
      {error && <p className="col-span-2 text-right text-[12.5px] text-destructive">{error}</p>}
    </li>
  );
}

/**
 * Настройки RAG в духе Claude Code: одна колонка, разделы с приглушёнными заголовками, строки
 * «название и пояснение — переключатель», волосяные линии. Настройки глобальные: сохранение меняет
 * консультанта для всех ответов стенда до перезапуска ядра.
 */
export function SettingsView() {
  const [data, setData] = useState<RagSettings | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "reset">("");

  const adopt = useCallback((d: RagSettings) => {
    setData(d);
    setDraft(Object.fromEntries(d.fields.map((f) => [f.key, f.kind === "int" || f.kind === "float" ? String(d.values[f.key]) : d.values[f.key]])));
  }, []);

  const load = useCallback(() => {
    setError("");
    getSettings()
      .then(adopt)
      .catch((e: Error) => setError(e.message));
  }, [adopt]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- первая загрузка настроек с сервера
    load();
  }, [load]);

  const parsed = useMemo(() => {
    if (!data) return { changes: {} as Record<string, SettingValue>, invalid: 0 };
    const changes: Record<string, SettingValue> = {};
    let invalid = 0;
    for (const f of data.fields) {
      const { value, error: err } = parse(f, draft[f.key]);
      if (err) invalid++;
      else if (value !== undefined && value !== data.values[f.key]) changes[f.key] = value;
    }
    return { changes, invalid };
  }, [data, draft]);
  const dirty = Object.keys(parsed.changes).length;

  const save = async () => {
    setBusy("save");
    try {
      adopt(await saveSettings(parsed.changes));
      toast.success("Настройки сохранены — действуют со следующего ответа");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const reset = async () => {
    setBusy("reset");
    try {
      adopt(await resetSettings());
      toast.success("Вернули значения из окружения");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const offEnv = data?.changed.length ?? 0;

  return (
    <AppShell>
      <PageBar icon={SlidersHorizontal} title="Настройки RAG" subtitle="поиск и генерация ответа">
        <Button
          variant="ghost"
          className="text-muted-foreground"
          onClick={reset}
          disabled={!data || !!busy || !offEnv}
        >
          {busy === "reset" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          Сбросить к окружению
        </Button>
        <Button onClick={save} disabled={!dirty || !!parsed.invalid || !!busy}>
          {busy === "save" && <Loader2 className="animate-spin" />}
          Сохранить
        </Button>
      </PageBar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] px-5 pt-4 pb-32 sm:px-6">
          {error && (
            <div className="mt-10 flex flex-col items-center gap-3 text-center">
              <AlertCircle className="size-5 text-destructive" />
              <p className="text-[14px] text-muted-foreground">Настройки не загрузились: {error}</p>
              <Button variant="outline" onClick={load}>
                Повторить
              </Button>
            </div>
          )}
          {!data && !error && (
            <div className="mt-16 flex justify-center text-muted-foreground" role="status" aria-label="Загрузка">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          {data && (
            <>
              <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                Действуют сразу для всех ответов стенда — со следующего вопроса — и до перезапуска ядра.{" "}
                {offEnv
                  ? `Отличаются от окружения: ${offEnv} из ${data.fields.length}.`
                  : "Сейчас всё как в окружении."}
              </p>

              {GROUPS.map((g) => (
                <section key={g.key} className="mt-9" aria-labelledby={`g-${g.key}`}>
                  <h2 id={`g-${g.key}`} className="text-[13px] font-medium text-muted-foreground">
                    {g.title}
                  </h2>
                  <ul className="mt-2 divide-y border-y">
                    {data.fields
                      .filter((f) => f.group === g.key)
                      .map((f) => (
                        <Row
                          key={f.key}
                          field={f}
                          draft={draft[f.key]}
                          saved={data.values[f.key]}
                          envValue={data.defaults[f.key]}
                          onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                        />
                      ))}
                  </ul>
                </section>
              ))}

              <section className="mt-9" aria-labelledby="g-model">
                <h2 id="g-model" className="text-[13px] font-medium text-muted-foreground">
                  Модель
                </h2>
                <ul className="mt-2 divide-y border-y">
                  <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 py-3.5">
                    <div>
                      <p className="text-[14px] font-medium">Генерация</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">Задаётся окружением ядра, здесь не меняется.</p>
                      <p className="mt-1 font-mono text-[11.5px] text-muted-foreground/80">LLM_MODEL</p>
                    </div>
                    <span className="font-mono text-[12.5px]">{data.model || "не настроена"}</span>
                  </li>
                </ul>
              </section>
            </>
          )}
        </div>
      </div>

      {/* Плашка несохранённых правок — как в настройках Claude: появляется снизу, пока есть что сохранить. */}
      {data && dirty > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center px-4">
          <div className="think-in pointer-events-auto flex items-center gap-3 rounded-full border bg-background py-1.5 pr-1.5 pl-4 text-[13.5px] shadow-[var(--shadow-pop)]">
            <span className="text-muted-foreground">
              {parsed.invalid ? "Исправьте значения с ошибкой" : `Не сохранено: ${dirty}`}
            </span>
            <Button variant="ghost" size="sm" onClick={() => adopt(data)} disabled={!!busy}>
              Отменить
            </Button>
            <Button size="sm" onClick={save} disabled={!!parsed.invalid || !!busy}>
              Сохранить
            </Button>
          </div>
        </div>
      )}
    </AppShell>
  );
}
