"use client";

import { AlertCircle, ChevronDown, FlaskConical, Loader2, LogIn, LogOut, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell, PageBar } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { type AdminSession, adminLogin, adminLogout, getAdminSession, getSettings, resetSettings, saveSettings } from "@/lib/api";
import { type Sandbox, readSandbox, writeSandbox } from "@/lib/sandbox";
import type { RagSettings, SettingField, SettingValue } from "@/lib/types";

/** Подписи и пояснения — на фронте: ядро отдаёт только ключи, типы и пределы. */
const COPY: Record<string, { label: string; hint: string; off?: string }> = {
  top_k: {
    label: "Фрагментов в контексте",
    hint: "Сколько лучших найденных разделов модель получает всегда — вместе с фактами по найденным продуктам и общими границами.",
  },
  n_candidates: { label: "Кандидатов для реранкера", hint: "Сколько разделов поиск передаёт на переранжирование." },
  full_docs: { label: "Документов целиком", hint: "Самые релевантные документы уходят модели полностью." },
  expand_docs: {
    label: "Документов с соседними разделами",
    hint: "Из скольких самых релевантных документов добавлять соседние разделы, пока хватает бюджета контекста; 0 — только найденные фрагменты.",
  },
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

/** Шаг ползунка: крупные пределы двигаются круглыми числами, температура — сотыми. */
const STEP: Record<string, number> = { context_chars: 1000, max_tokens: 64, temperature: 0.05 };

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
          className="h-8 w-[15.5rem] max-w-full appearance-none truncate rounded-md border border-input bg-background pr-8 pl-2.5 text-[13px] outline-none transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {field.options?.map((o) => (
            <option key={String(o)} value={String(o)}>
              {OPTION_LABELS[field.key]?.[String(o)] ?? String(o)}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </span>
    );
  }
  // Число: ползунок для быстрой прикидки и поле для точного значения — оба правят одно и то же.
  const min = field.min ?? 0;
  const max = field.max ?? 100;
  const step = STEP[field.key] ?? (field.kind === "float" ? 0.1 : 1);
  const n = Number(String(value).replace(",", "."));
  const current = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
  return (
    <span className="flex items-center gap-3">
      <Slider
        value={[current]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => {
          const next = Array.isArray(v) ? v[0] : v;
          onChange(String(field.kind === "float" ? Math.round(next * 100) / 100 : next));
        }}
        aria-label={copy?.label ?? field.key}
        className="w-36 data-horizontal:w-36 max-sm:hidden"
      />
      <input
        id={id}
        inputMode={field.kind === "float" ? "decimal" : "numeric"}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        className="tnum h-8 w-24 rounded-md border border-input bg-background px-2.5 text-right font-mono text-[12px] outline-none transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
      />
    </span>
  );
}

function Row({
  field,
  draft,
  saved,
  envValue,
  baseLabel,
  onChange,
}: {
  field: SettingField;
  draft: SettingValue | string;
  saved: SettingValue;
  /** С чем сравнивать: у администратора — окружение ядра, в песочнице — общие настройки стенда. */
  envValue: SettingValue;
  baseLabel: string;
  onChange: (v: SettingValue | string) => void;
}) {
  const copy = COPY[field.key] ?? { label: field.key, hint: "" };
  const { value, error } = parse(field, draft);
  const dirty = value !== undefined && value !== saved;
  const offEnv = value !== undefined && value !== envValue;

  return (
    <li className="group/row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 py-3">
      <div className="min-w-0">
        <label htmlFor={`s-${field.key}`} className="flex items-center gap-2 text-[13px] font-medium">
          {copy.label}
          {dirty && <span className="size-1.5 shrink-0 rounded-full bg-info" aria-label="не сохранено" />}
        </label>
        <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
          {field.available ? copy.hint : (copy.off ?? copy.hint)}
        </p>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted-foreground">
          <span>{field.env}</span>
          {offEnv && (
            <>
              <span aria-hidden>·</span>
              <span className="font-sans">
                {baseLabel}: {show(field, envValue)}
              </span>
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
      {error && <p className="col-span-2 text-right text-[12px] text-destructive">{error}</p>}
    </li>
  );
}

function toDraft(fields: SettingField[], values: Record<string, SettingValue>): Draft {
  return Object.fromEntries(fields.map((f) => [f.key, f.kind === "int" || f.kind === "float" ? String(values[f.key]) : values[f.key]]));
}

/** Свои значения песочницы — только по известным ядру ключам: остальное ядро отвергло бы. */
function overlay(data: RagSettings, sandbox: Sandbox): Record<string, SettingValue> {
  const known = new Set(data.fields.map((f) => f.key));
  return { ...data.values, ...Object.fromEntries(Object.entries(sandbox).filter(([k]) => known.has(k))) };
}

function AdminLogin({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await adminLogin(token);
      toast.success("Вы вошли как администратор: «Сохранить» меняет бота для всех");
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-center gap-2" aria-label="Вход администратора">
      <label htmlFor="admin-token" className="sr-only">
        Токен администратора
      </label>
      <input
        id="admin-token"
        type="password"
        autoComplete="current-password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="Токен администратора (EB_ADMIN_TOKEN)"
        className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-3 text-[13.5px] outline-none transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      />
      <Button type="submit" size="sm" disabled={!token || busy}>
        {busy && <Loader2 className="animate-spin" />}
        Войти
      </Button>
    </form>
  );
}

/**
 * Настройки RAG в духе Claude Code: одна колонка, разделы с приглушёнными заголовками, строки
 * «название и пояснение — переключатель», волосяные линии.
 *
 * Два режима. Администратор (вошёл с EB_ADMIN_TOKEN) меняет консультанта для всех ответов стенда до
 * перезапуска ядра. Все остальные — в песочнице: значения хранятся в этом браузере и уходят с каждым
 * вопросом стенда полем overrides, то есть действуют только на свои ответы. Так жюри может пробовать
 * настройки, не ломая бота другим посетителям и демо.
 */
export function SettingsView() {
  const [data, setData] = useState<RagSettings | null>(null);
  const [session, setSession] = useState<AdminSession>({ enabled: false, admin: false });
  const [sandbox, setSandbox] = useState<Sandbox>({});
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "reset">("");
  const [login, setLogin] = useState(false);
  const admin = session.admin;

  /** Поля с пределами режима: в песочнице у контекста и токенов потолок ниже, чем у администратора. */
  const fields = useMemo(
    () =>
      (data?.fields ?? []).map((f) => (!admin && f.sandbox_max !== undefined ? { ...f, max: f.sandbox_max } : f)),
    [data, admin],
  );

  /** Значения, от которых считаются правки: у администратора — общие, в песочнице — общие поверх своих. */
  const current = useMemo(() => (data ? (admin ? data.values : overlay(data, sandbox)) : {}), [data, admin, sandbox]);

  const adopt = useCallback((d: RagSettings, values: Record<string, SettingValue>) => {
    setData(d);
    setDraft(toDraft(d.fields, values));
  }, []);

  const load = useCallback(() => {
    setError("");
    Promise.all([getSettings(), getAdminSession()])
      .then(([d, s]) => {
        const own = readSandbox();
        setSession(s);
        setSandbox(own);
        adopt(d, s.admin ? d.values : overlay(d, own));
      })
      .catch((e: Error) => setError(e.message));
  }, [adopt]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- первая загрузка настроек с сервера
    load();
  }, [load]);

  const parsed = useMemo(() => {
    if (!data) return { changes: {} as Record<string, SettingValue>, values: {} as Record<string, SettingValue>, invalid: 0 };
    const changes: Record<string, SettingValue> = {};
    const values: Record<string, SettingValue> = {};
    let invalid = 0;
    for (const f of fields) {
      const { value, error: err } = parse(f, draft[f.key]);
      if (err) invalid++;
      else if (value !== undefined) {
        values[f.key] = value;
        if (value !== current[f.key]) changes[f.key] = value;
      }
    }
    return { changes, values, invalid };
  }, [data, fields, draft, current]);
  const dirty = Object.keys(parsed.changes).length;

  const save = async () => {
    if (!data) return;
    if (!admin) {
      // В песочнице храним только то, что отличается от общих настроек: общие могут поменяться.
      const own = Object.fromEntries(Object.entries(parsed.values).filter(([k, v]) => v !== data.values[k]));
      writeSandbox(own);
      setSandbox(own);
      adopt(data, overlay(data, own));
      toast.success("Сохранено для вас — действует на ваши ответы на стенде со следующего вопроса");
      return;
    }
    setBusy("save");
    try {
      const d = await saveSettings(parsed.changes);
      adopt(d, d.values);
      toast.success("Настройки сохранены для всех — действуют со следующего ответа");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const reset = async () => {
    if (!data) return;
    if (!admin) {
      writeSandbox({});
      setSandbox({});
      adopt(data, data.values);
      toast.success("Свои настройки сброшены — ответы снова с общими");
      return;
    }
    setBusy("reset");
    try {
      const d = await resetSettings();
      adopt(d, d.values);
      toast.success("Вернули значения из окружения");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const logout = async () => {
    await adminLogout();
    load();
  };

  const offEnv = data?.changed.length ?? 0;
  const own = data ? Object.keys(sandbox).filter((k) => data.fields.some((f) => f.key === k)).length : 0;
  const resetLabel = admin ? "Сбросить к окружению" : "Сбросить свои";

  return (
    <AppShell>
      <PageBar icon={SlidersHorizontal} title="Настройки RAG" subtitle={admin ? "для всех посетителей" : "песочница"}>
        {admin ? (
          <Button variant="ghost" className="text-muted-foreground max-sm:size-9 max-sm:px-0" onClick={logout} aria-label="Выйти" title="Выйти">
            <LogOut />
            <span className="max-sm:hidden">Выйти</span>
          </Button>
        ) : session.enabled ? (
          <Button
            variant="ghost"
            className="text-muted-foreground max-sm:size-9 max-sm:px-0"
            onClick={() => setLogin((v) => !v)}
            aria-expanded={login}
            aria-label="Войти как администратор"
            title="Войти как администратор"
          >
            <LogIn />
            <span className="max-sm:hidden">Администратор</span>
          </Button>
        ) : null}
        {/* На узком экране — только значок: подпись съедала место заголовка страницы. */}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground max-sm:size-8 max-sm:px-0"
          onClick={reset}
          disabled={!data || !!busy || !(admin ? offEnv : own)}
          aria-label={resetLabel}
          title={resetLabel}
        >
          {busy === "reset" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          <span className="max-sm:hidden">{resetLabel}</span>
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || !!parsed.invalid || !!busy}>
          {busy === "save" && <Loader2 className="animate-spin" />}
          Сохранить
        </Button>
      </PageBar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] px-5 pt-6 pb-32 sm:px-6">
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
              {admin ? (
                <p className="text-[13.5px] leading-relaxed text-muted-foreground">
                  Вы администратор: изменения действуют сразу для всех ответов стенда — со следующего вопроса — и до
                  перезапуска ядра.{" "}
                  {offEnv
                    ? `Отличаются от окружения: ${offEnv} из ${data.fields.length}.`
                    : "Сейчас всё как в окружении."}
                  {own > 0 && ` В этом браузере ещё действуют ваши настройки песочницы: ${own}.`}
                </p>
              ) : (
                <div className="flex gap-3 rounded-xl bg-muted/60 px-4 py-3 text-[13.5px] leading-relaxed">
                  <FlaskConical className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">Песочница.</span> Изменения хранятся в этом браузере
                    и действуют только на ваши ответы в чате стенда — у остальных посетителей и в виджете бот отвечает
                    с общими настройками. В отладке такой ответ помечен «ответ с вашими настройками».{" "}
                    {own ? `Своих значений: ${own}.` : "Сейчас всё как у всех."}
                  </p>
                </div>
              )}
              {!admin && login && <AdminLogin onDone={() => { setLogin(false); load(); }} />}

              {GROUPS.map((g) => (
                <section key={g.key} className="mt-9" aria-labelledby={`g-${g.key}`}>
                  <h2 id={`g-${g.key}`} className="text-[14px] font-medium">
                    {g.title}
                  </h2>
                  <ul className="mt-2 divide-y border-y">
                    {fields
                      .filter((f) => f.group === g.key)
                      .map((f) => (
                        <Row
                          key={f.key}
                          field={f}
                          draft={draft[f.key]}
                          saved={current[f.key]}
                          envValue={admin ? data.defaults[f.key] : data.values[f.key]}
                          baseLabel={admin ? "в окружении" : "у всех"}
                          onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                        />
                      ))}
                  </ul>
                </section>
              ))}

              <section className="mt-9" aria-labelledby="g-model">
                <h2 id="g-model" className="text-[14px] font-medium">
                  Модель
                </h2>
                <ul className="mt-2 divide-y border-y">
                  <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 py-3">
                    <div>
                      <p className="text-[13px] font-medium">Генерация</p>
                      <p className="mt-0.5 text-[12px] text-muted-foreground">Задаётся окружением ядра, здесь не меняется.</p>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">LLM_MODEL</p>
                    </div>
                    <span className="font-mono text-[12px] text-muted-foreground">{data.model || "не настроена"}</span>
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
          <div className="think-in pointer-events-auto flex items-center gap-2 rounded-xl border bg-popover py-1.5 pr-1.5 pl-3.5 text-[13px] shadow-[var(--shadow-pop)]">
            <span className="text-muted-foreground">
              {parsed.invalid ? "Исправьте значения с ошибкой" : `Не сохранено: ${dirty}`}
            </span>
            <Button variant="ghost" size="sm" onClick={() => adopt(data, current)} disabled={!!busy}>
              Отменить
            </Button>
            <Button size="sm" onClick={save} disabled={!!parsed.invalid || !!busy}>
              {admin ? "Сохранить для всех" : "Сохранить для себя"}
            </Button>
          </div>
        </div>
      )}
    </AppShell>
  );
}
