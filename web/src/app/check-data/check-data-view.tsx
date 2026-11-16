"use client";

import {
  BookOpen,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  FileCheck2,
  FileSpreadsheet,
  Headset,
  Loader2,
  RotateCcw,
  Info,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AppShell, PageBar } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useKb } from "@/hooks/use-kb";
import {
  type Analysis,
  KB_QUOTES,
  KB_SECTION,
  type Mapping,
  OPTIONAL_REQUIREMENTS,
  REQUIREMENT_LABELS,
  REQUIREMENT_QUOTES,
  REQUIREMENTS,
  ROLE_LABELS,
  ROLES,
  type Requirement,
  type Role,
  type Table,
  analyze,
  assignColumn,
  autoMap,
  decodeBytes,
  kbSectionHref,
  looksLikeZip,
  readTable,
} from "@/lib/data-readiness";
import { cn } from "@/lib/utils";

/**
 * Технический предохранитель, а не правило из базы: файл целиком читается в память вкладки,
 * и на очень больших выгрузках браузер просто зависнет. Пользователю число не показываем.
 */
const MAX_BYTES = 200 * 1024 * 1024;

interface Loaded {
  name: string;
  table: Table;
  auto: Mapping;
  mapping: Mapping;
}

/** Колонка, в которой лежат сведения для каждого требования, — для подписи «где нашли». */
const SOURCE: Partial<Record<Requirement, Role[]>> = {
  channelId: ["channel"],
  dates: ["date"],
  readings: ["reading"],
  dailyDayNight: ["day", "night"],
  address: ["address"],
  serial: ["serial"],
  category: ["category"],
};

const ruDate = (iso?: string) => (iso ? iso.split("-").reverse().join(".") : "");
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);
const DELIMITERS: Record<Table["delimiter"], string> = { ";": "«;»", ",": "«,»", "\t": "табуляция" };

function detail(req: Requirement, a: Analysis, file: Loaded): string {
  const name = (role: Role) => {
    const i = file.mapping[role];
    return i === undefined ? undefined : `«${file.table.headers[i]}»`;
  };
  const ok = a.readiness.flags[req];
  if (req === "archiveYear" || req === "dates") {
    if (!a.from) return file.mapping.date === undefined ? "нет колонки с датой" : "даты не распознаны";
    const range = `с ${ruDate(a.from)} по ${ruDate(a.to)}`;
    return req === "dates" && a.badDates ? `${range}; не распознано дат: ${a.badDates.toLocaleString("ru")}` : range;
  }
  if (req === "intervals") {
    if (a.stepMinutes === undefined) return "шаг показаний не определить";
    if (a.stepMinutes % (24 * 60) === 0) return "показания суточные";
    return a.stepMinutes < 60 ? `шаг ${a.stepMinutes} мин` : `шаг ${a.stepMinutes / 60} ч`;
  }
  if (req === "readings" && ok && file.mapping.reading === undefined) return "значения день и ночь";
  const roles = SOURCE[req] ?? [];
  const names = roles.map(name);
  if (names.every(Boolean)) return ok ? names.join(" и ") : `${names.join(" и ")} — без значений`;
  return `нет колонки: ${roles
    .filter((r) => file.mapping[r] === undefined)
    .map((r) => ROLE_LABELS[r].toLowerCase())
    .join(", ")}`;
}

function Verdict({ analysis, kbHref }: { analysis: Analysis; kbHref: string }) {
  const { ready, missing, flags } = analysis.readiness;
  return (
    <div
      className={cn(
        "rounded-xl px-4 py-4 sm:px-5",
        ready ? "bg-success-soft" : "bg-warning-soft",
      )}
    >
      <div className="flex gap-3">
        {ready ? (
          <CircleCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
        ) : (
          <CircleAlert className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="text-[16px] font-semibold leading-snug">
            {ready
              ? "Данных достаточно, чтобы начать"
              : `Не хватает: ${missing.map((m) => REQUIREMENT_LABELS[m]).join(", ")}`}
          </p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
            {ready
              ? "В выгрузке есть всё, что база знаний перечисляет для поиска коммерческих потерь."
              : "Это сведения из раздела базы знаний для поиска коммерческих потерь. Добавьте их в выгрузку и проверьте файл снова — или обсудите с менеджером, что можно выгрузить."}
            {ready && !flags.intervals && " Часовых или получасовых интервалов нет: в базе они «желательны», начать можно и без них."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button nativeButton={false} render={<Link href="/playground" />}>
              <Headset />
              Обсудить в чате
            </Button>
            <Button variant="outline" nativeButton={false} render={<Link href={kbHref} />}>
              <BookOpen />
              Раздел базы знаний
            </Button>
          </div>
          <p className="mt-2 text-[12.5px] text-muted-foreground">
            «Передать менеджеру» открывает чат с консультантом. Содержимое файла туда не попадает.
          </p>
        </div>
      </div>
    </div>
  );
}

function Checklist({ analysis, file }: { analysis: Analysis; file: Loaded }) {
  return (
    <section className="mt-9" aria-labelledby="g-checks">
      <h2 id="g-checks" className="text-[13px] font-medium text-muted-foreground">
        Что проверили
      </h2>
      <ul className="mt-2 divide-y border-y">
        {REQUIREMENTS.map((req) => {
          const ok = analysis.readiness.flags[req];
          const optional = OPTIONAL_REQUIREMENTS.includes(req);
          const state = ok ? "есть" : optional ? "нет, но это желательно, а не обязательно" : "не хватает";
          return (
            <li key={req} className="flex gap-3 py-3">
              {ok ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              ) : optional ? (
                <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-[14px] font-medium">
                  {capital(REQUIREMENT_LABELS[req])}
                  <span className="sr-only">: {state}.</span>
                  {optional && <span className="text-[12px] font-normal text-muted-foreground">желательно</span>}
                </p>
                <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">{detail(req, analysis, file)}</p>
                <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
                  В базе: «{REQUIREMENT_QUOTES[req]}»
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Columns({ file, onChange, onReset }: { file: Loaded; onChange: (m: Mapping) => void; onReset: () => void }) {
  const sample = (column: number | undefined) =>
    column === undefined ? undefined : file.table.rows.find((r) => (r[column] ?? "").trim())?.[column]?.trim();
  const edited = ROLES.some((r) => file.mapping[r] !== file.auto[r]);
  return (
    <section className="mt-9" aria-labelledby="g-columns">
      <div className="flex items-center justify-between gap-3">
        <h2 id="g-columns" className="text-[13px] font-medium text-muted-foreground">
          Колонки
        </h2>
        {edited && (
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onReset}>
            <RotateCcw />
            Как было
          </Button>
        )}
      </div>
      <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
        Сопоставили автоматически по названиям колонок. Если ошиблись — выберите колонку вручную, итог пересчитается сразу.
      </p>
      <ul className="mt-2 divide-y border-y">
        {ROLES.map((role) => {
          const id = `col-${role}`;
          const value = file.mapping[role];
          const example = sample(value);
          return (
            <li key={role} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 py-3">
              <div className="min-w-0">
                <label htmlFor={id} className="text-[14px] font-medium">
                  {ROLE_LABELS[role]}
                </label>
                <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground" title={example}>
                  {value === undefined ? "не нашли — выберите, если колонка есть" : example ? `например, ${example}` : "колонка пустая"}
                </p>
              </div>
              <span className="relative inline-flex">
                <select
                  id={id}
                  value={value === undefined ? "" : String(value)}
                  onChange={(e) =>
                    onChange(assignColumn(file.mapping, role, e.target.value === "" ? undefined : Number(e.target.value)))
                  }
                  className="h-8 w-[14rem] max-w-[45vw] appearance-none truncate rounded-lg border border-input bg-background pr-8 pl-3 text-[13.5px] outline-none transition-colors hover:border-ring/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  <option value="">— нет в файле —</option>
                  {file.table.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {h}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * «Проверить выгрузку» (T21): хватает ли в выгрузке сетевой компании сведений для поиска коммерческих потерь.
 * Единственный сетевой запрос страницы — `GET /api/kb`, чтобы найти id раздела базы для ссылки. Итог для паспорта клиента (T2) — `DataReadiness` из `@/lib/data-readiness`:
 * только флаги, пока никуда не отправляется.
 */
export function CheckDataView() {
  const { kb } = useKb();
  const kbHref = kbSectionHref(kb?.data.docs);
  const [file, setFile] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const analysis = useMemo(() => (file ? analyze(file.table, file.mapping) : null), [file]);

  const open = async (picked: File | undefined) => {
    if (!picked) return;
    setError("");
    if (picked.size > MAX_BYTES) {
      setError("Файл слишком большой для проверки в браузере. Выгрузите меньше каналов учёта — глубину архива оставьте.");
      return;
    }
    setBusy(true);
    try {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      if (looksLikeZip(bytes) || /\.xlsx?$/i.test(picked.name)) {
        throw new Error(
          "Это файл Excel, а здесь проверяется CSV. Сохраните выгрузку в Excel через «Сохранить как» → «CSV (разделители — точка с запятой)» и выберите его.",
        );
      }
      const table = readTable(decodeBytes(bytes));
      const auto = autoMap(table.headers);
      setFile({ name: picked.name, table, auto, mapping: auto });
    } catch (e) {
      setFile(null);
      setError((e as Error).message || "Не удалось прочитать файл.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <PageBar icon={FileCheck2} title="Проверить выгрузку" subtitle="поиск потерь" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-5 pt-4 pb-32 sm:px-6">
          <p className="text-[14px] leading-relaxed text-muted-foreground">
            Проверим, есть ли в выгрузке данных учёта всё, что база знаний перечисляет{" "}
            <Link href={kbHref} className="text-foreground underline underline-offset-2 hover:text-brand-text">
              для поиска коммерческих потерь
            </Link>
            . Сам поиск потерь и оценка абонентов здесь не выполняются — только проверка, хватает ли данных, чтобы начать.
          </p>

          <div className="mt-4 flex gap-3 rounded-xl bg-muted/60 px-4 py-3 text-[13.5px] leading-relaxed">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-muted-foreground">
              В базе для поиска потерь названа «{KB_QUOTES.anonymized}» — обезличьте её перед проверкой.
            </p>
          </div>

          {file ? (
            <div className="mt-6 flex items-center gap-3 rounded-xl border px-4 py-3">
              <FileSpreadsheet className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{file.name}</p>
                <p className="text-[12.5px] text-muted-foreground">
                  Строк: {file.table.rows.length.toLocaleString("ru")} · колонок: {file.table.headers.length} · разделитель{" "}
                  {DELIMITERS[file.table.delimiter]}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => setFile(null)}
                aria-label="Убрать файл и выбрать другой"
                title="Выбрать другой файл"
              >
                <X />
              </Button>
            </div>
          ) : (
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                open(e.dataTransfer.files[0]);
              }}
              className={cn(
                "mt-6 flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors hover:border-ring/60 hover:bg-muted/40 has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/30",
                dragging && "border-ring bg-muted/40",
              )}
            >
              {busy ? (
                <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
              ) : (
                <Upload className="size-5 text-muted-foreground" aria-hidden />
              )}
              <span className="text-[14px] font-medium">Выбрать CSV-файл выгрузки</span>
              <span className="text-[12.5px] text-muted-foreground">
                или перетащите его сюда · разделитель «;» или «,» · кодировка UTF-8 или Windows-1251
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  open(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          )}

          {error && (
            <p role="alert" className="mt-3 flex gap-2 text-[13.5px] leading-snug text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          {/* Живая область есть всегда, чтобы экранный диктор озвучил итог, когда он появится. */}
          <div role="status" aria-live="polite">
            {analysis && (
              <div className="mt-6">
                <Verdict analysis={analysis} kbHref={kbHref} />
              </div>
            )}
          </div>

          {file && analysis && (
            <>
              <Checklist analysis={analysis} file={file} />
              <Columns
                file={file}
                onChange={(mapping) => setFile({ ...file, mapping })}
                onReset={() => setFile({ ...file, mapping: file.auto })}
              />
              <p className="mt-6 text-[12.5px] leading-relaxed text-muted-foreground">
                Требования — из раздела базы знаний «{KB_SECTION}». {KB_QUOTES.minimum} {KB_QUOTES.intervals}
              </p>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
