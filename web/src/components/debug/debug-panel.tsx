"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Copy,
  Cpu,
  FileText,
  Info,
  Loader2,
  MessageCircleQuestion,
  ScanSearch,
  Timer,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { citationOrder, SourceNumber } from "@/components/chat/answer-text";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { KbIndex } from "@/hooks/use-kb";
import type { AnswerPayload, Citation, Hit, Message, Retrieval } from "@/lib/types";
import { cn } from "@/lib/utils";

const STAGES: Record<string, { label: string; color: string }> = {
  retrieval: { label: "Поиск", color: "bg-chart-1" },
  generation: { label: "Генерация", color: "bg-chart-2" },
  refine: { label: "Доработка", color: "bg-chart-3" },
  guard: { label: "Проверка", color: "bg-chart-4" },
};

const fmt = (n: number) => n.toLocaleString("ru");
const sec = (ms: number) => `${(ms / 1000).toFixed(1).replace(".", ",")} с`;

/** Раздел базы: название раздела и документ отдельной строкой; клик открывает раздел. */
function ChunkRow({
  id,
  kb,
  onOpen,
  title,
  path,
  aside,
  sub,
  dim,
}: {
  id: string;
  kb: KbIndex | null;
  onOpen: (id: string) => void;
  title?: string;
  path?: string;
  aside?: React.ReactNode;
  sub?: React.ReactNode;
  dim?: boolean;
}) {
  const e = kb?.byId.get(id);
  const section = (path ?? e?.chunk.path ?? id).split(" > ").pop();
  const doc = title ?? e?.doc.title;
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      title={`#${id}`}
      className={cn(
        "group/row flex w-full min-w-0 items-start gap-3 text-left transition-opacity",
        dim && "opacity-55 hover:opacity-100",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] leading-snug font-medium decoration-border underline-offset-[3px] group-hover/row:underline">
          {section}
        </span>
        {doc && doc !== section && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{doc}</span>}
        {sub}
      </span>
      {aside}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-6 py-12 text-center text-[14px] text-muted-foreground">{children}</div>;
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-medium text-muted-foreground">{title}</h3>
        {aside && <div className="text-xs text-muted-foreground">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function Footnote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
      <Info className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Note({ tone = "warning", children }: { tone?: "warning" | "danger"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] leading-snug",
        tone === "warning" ? "bg-warning-soft text-warning" : "bg-destructive-soft text-destructive",
      )}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function Fold({
  summary,
  open,
  children,
  className,
}: {
  summary: React.ReactNode;
  open?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details open={open} className={cn("group/fold rounded-xl border", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px] [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/fold:rotate-90" />
        {summary}
      </summary>
      <div className="border-t px-3 py-3">{children}</div>
    </details>
  );
}

/** Сколько слов совпало: тёмная полоса — уверенная опора, светлая — слабая (цвет только у проблем). */
function Overlap({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = pct >= 50 ? "bg-foreground/70" : pct >= 30 ? "bg-foreground/35" : "bg-dim";
  return (
    <span className="flex shrink-0 items-center gap-2 pt-0.5">
      <span className="h-1.5 w-10 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full rounded-full", tone)} style={{ width: `${Math.max(6, pct)}%` }} />
      </span>
      <span className="tnum w-8 text-right font-mono text-[11.5px] text-muted-foreground">{pct}%</span>
    </span>
  );
}

// ---------- Опора ----------
type Verdict = "strong" | "weak" | "none" | "numbers" | "question";

function verdict(c: Citation): Verdict {
  if (c.question) return "question";
  if (c.unsupported_numbers.length) return "numbers";
  if (!c.support.length) return "none";
  return Math.max(...c.support.map((s) => s.overlap)) >= 0.5 ? "strong" : "weak";
}

const VERDICT: Record<Verdict, { label: string; bar: string; icon: React.ReactNode }> = {
  strong: { label: "опора найдена", bar: "bg-foreground/70", icon: <CheckCircle2 className="size-4 text-muted-foreground" /> },
  weak: { label: "слабая опора", bar: "bg-foreground/30", icon: <CheckCircle2 className="size-4 text-dim" /> },
  none: { label: "без опоры", bar: "bg-warning", icon: <AlertTriangle className="size-4 text-warning" /> },
  numbers: { label: "числа без опоры", bar: "bg-destructive", icon: <AlertTriangle className="size-4 text-destructive" /> },
  question: {
    label: "вопрос клиенту",
    bar: "bg-dim",
    icon: <CircleHelp className="size-4 text-muted-foreground" />,
  },
};

function SupportTab({ a, kb, onOpen }: { a: AnswerPayload; kb: KbIndex | null; onOpen: (id: string) => void }) {
  const order = citationOrder(a);
  const verdicts = a.citations.map(verdict);
  const claims = verdicts.filter((v) => v !== "question").length;
  const grounded = verdicts.filter((v) => v === "strong" || v === "weak").length;
  const questions = verdicts.length - claims;
  const loose = a.citations.reduce((n, c) => n + c.unsupported_numbers.length, 0);

  return (
    <div className="space-y-5 p-5">
      <div className="space-y-2.5">
        <div className="flex items-baseline gap-2">
          <span className="tnum text-[22px] leading-none font-semibold tracking-tight">
            {grounded}
            <span className="text-muted-foreground">/{claims}</span>
          </span>
          <span className="text-[13px] text-muted-foreground">утверждений опираются на разделы базы</span>
        </div>
        <div className="flex h-1 gap-1" aria-hidden>
          {verdicts.map((v, i) => (
            <span key={i} className={cn("flex-1 rounded-full", VERDICT[v].bar)} />
          ))}
        </div>
        <div className="tnum flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {questions > 0 && <span>вопросов клиенту: {questions}</span>}
          <span className={cn(loose > 0 && "text-destructive")}>чисел без опоры: {loose}</span>
          <span>источников: {order.length}</span>
        </div>
      </div>

      <ol className="-mx-5 divide-y border-y">
        {a.citations.map((c, i) => {
          const v = verdicts[i];
          return (
            <li key={i} className="grid grid-cols-[20px_1fr] gap-x-3 px-5 py-4">
              <span className="pt-[3px]" title={VERDICT[v].label}>
                {VERDICT[v].icon}
              </span>
              <div className="min-w-0 space-y-3">
                <p className="text-[14px] leading-relaxed">{c.sentence}</p>
                {c.question ? (
                  <p className="text-xs text-muted-foreground">Уточняющий вопрос — опора не нужна</p>
                ) : c.support.length ? (
                  <ul className="space-y-2.5">
                    {c.support.map((s) => (
                      <li key={s.id} className="flex items-start gap-2.5">
                        <SourceNumber n={order.indexOf(s.id) + 1} className="mt-px size-[18px]" />
                        <ChunkRow
                          id={s.id}
                          kb={kb}
                          onOpen={onOpen}
                          path={s.path}
                          title={s.title}
                          aside={<Overlap value={s.overlap} />}
                          sub={
                            s.numbers.length > 0 && (
                              <span className="mt-1.5 flex flex-wrap gap-1">
                                {s.numbers.map((n) => (
                                  <span
                                    key={n}
                                    className="tnum rounded-md bg-muted px-1.5 py-px font-mono text-[11px] text-foreground/80"
                                  >
                                    {n}
                                  </span>
                                ))}
                              </span>
                            )
                          }
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[13px] text-warning">Не нашлось раздела с похожей формулировкой</p>
                )}
                {c.unsupported_numbers.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-destructive">
                    Числа без опоры:
                    {c.unsupported_numbers.map((n) => (
                      <span key={n} className="tnum rounded-md bg-destructive-soft px-1.5 py-px font-mono text-[11px] text-destructive">
                        {n}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <Footnote>
        Эвристика стенда: предложения сопоставлены с разделами контекста по совпадению основ слов и чисел. Модель
        не размечает источники сама — по регламенту ответ одна строка без разметки.
      </Footnote>
    </div>
  );
}

// ---------- Поиск ----------
function Score({ hit, max }: { hit: Hit; max: number }) {
  const v = hit.score ?? 0;
  const pct = max > 0 ? Math.max(6, (v / max) * 100) : 0;
  return (
    <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
      <span className="tnum font-mono text-[11.5px] text-muted-foreground">
        {hit.score === null ? "—" : v < 0.1 ? v.toFixed(4) : v.toFixed(3)}
      </span>
      <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", hit.in_context ? "bg-info" : "bg-dim")}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; count: number }[];
}) {
  return (
    <div className="inline-flex rounded-lg bg-muted p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
            value === o.value && "bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)] dark:bg-accent",
          )}
        >
          {o.label}
          <span className="tnum font-mono text-[11px] text-muted-foreground">{o.count}</span>
        </button>
      ))}
    </div>
  );
}

function SearchTab({ r, kb, onOpen }: { r: Retrieval; kb: KbIndex | null; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<"all" | "in" | "out">("all");
  const inContext = r.hits.filter((h) => h.in_context).length;
  const hits = r.hits.filter((h) => (filter === "all" ? true : filter === "in" ? h.in_context : !h.in_context));
  const max = Math.max(...r.hits.map((h) => h.score ?? 0));
  const stage = r.hits[0]?.stage;
  return (
    <div className="space-y-5 p-5">
      <Section title="Запрос к базе" aside={<span className="font-mono">{[stage, r.dense ? "bm25 + эмбеддинги" : "bm25", `схема ${r.arch}`].filter(Boolean).join(" · ")}</span>}>
        <div className="rounded-xl bg-surface px-3.5 py-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Смысловой{stage === "rerank" ? " · реранкер" : ""}</div>
          <p className="text-[13.5px] leading-relaxed">{r.queries.semantic || "—"}</p>
          {r.queries.lexical && (
            <details className="group/lex mt-3 border-t pt-2.5">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3 transition-transform group-open/lex:rotate-90" />
                Лексический (BM25)
              </summary>
              <p className="mt-1.5 font-mono text-[12px] leading-relaxed text-muted-foreground">{r.queries.lexical}</p>
            </details>
          )}
        </div>
      </Section>

      <Section title="Кандидаты">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Все", count: r.hits.length },
            { value: "in", label: "В контексте", count: inContext },
            { value: "out", label: "Отброшены", count: r.hits.length - inContext },
          ]}
        />
        {hits.length ? (
          <ol className="-mx-5 divide-y border-y">
            {hits.map((h) => (
              <li key={h.id} className="grid grid-cols-[28px_1fr] gap-x-2 px-5 py-3">
                <span className="flex flex-col items-start gap-1.5 pt-px">
                  <span className="tnum font-mono text-[11.5px] text-muted-foreground">{String(h.rank).padStart(2, "0")}</span>
                  <span
                    className={cn("size-1.5 rounded-full", h.in_context ? "bg-info" : "bg-dim")}
                    title={h.in_context ? "в контексте" : "отброшен"}
                  />
                </span>
                <ChunkRow
                  id={h.id}
                  kb={kb}
                  onOpen={onOpen}
                  title={h.title}
                  path={h.path}
                  dim={!h.in_context}
                  aside={<Score hit={h} max={max} />}
                  sub={<span className="mt-1 line-clamp-1 text-xs text-muted-foreground/80">{h.preview}</span>}
                />
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[13px] text-muted-foreground">Пусто.</p>
        )}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-info" /> ушёл модели
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-dim" /> отброшен
          </span>
        </div>
      </Section>
    </div>
  );
}

// ---------- Контекст ----------
function ContextTab({
  a,
  r,
  kb,
  onOpen,
}: {
  a: AnswerPayload;
  r: Retrieval | null;
  kb: KbIndex | null;
  onOpen: (id: string) => void;
}) {
  const ids = useMemo(() => r?.context.chunk_ids ?? [], [r]);
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const id of ids) {
      const doc = kb?.byId.get(id)?.doc.doc ?? "?";
      map.set(doc, [...(map.get(doc) ?? []), id]);
    }
    return [...map.entries()].sort((x, y) => y[1].length - x[1].length);
  }, [ids, kb]);
  const full = new Set(r?.context.full_docs ?? []);
  const docSources = a.sources.filter((s) => s.kind === "doc");
  const chunkSources = a.sources.filter((s) => s.kind !== "doc");

  const stats = [
    { value: fmt(ids.length), label: "разделов" },
    { value: fmt(full.size), label: "документов целиком" },
    { value: fmt(r?.context.chars ?? 0), label: "символов" },
  ];

  return (
    <div className="space-y-6 p-5">
      <div className="space-y-3">
        <dl className="grid grid-cols-3 divide-x overflow-hidden rounded-xl bg-surface">
          {stats.map((s) => (
            <div key={s.label} className="px-3.5 py-3">
              <dd className="tnum text-[18px] leading-none font-semibold tracking-tight">{s.value}</dd>
              <dt className="mt-1.5 text-xs text-muted-foreground">{s.label}</dt>
            </div>
          ))}
        </dl>
        <Footnote>
          {full.size
            ? "Самые релевантные документы уходят целиком (эталон часто опирается на соседние разделы), остальные — лучшими фрагментами, плюс справочник: карта продуктов, числа, границы консультации."
            : "Лучшие фрагменты поиска, соседние разделы главного документа и ограничения («можно / нельзя утверждать») по найденным продуктам."}
        </Footnote>
      </div>

      {docSources.length > 0 && (
        <Section title="Документы целиком" aside={<span className="tnum">{docSources.length}</span>}>
          <ul className="-mx-5 divide-y border-y">
            {docSources.map((s, i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-2.5">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                {s.chunk_id ? (
                  <ChunkRow id={s.chunk_id} kb={kb} onOpen={onOpen} path={s.title} />
                ) : (
                  <span className="text-[13.5px] font-medium">{s.title}</span>
                )}
                <span className="tnum shrink-0 font-mono text-[11.5px] text-muted-foreground">
                  {kb?.byDoc.get(s.doc)?.chunks.length ?? ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {chunkSources.length > 0 && (
        <Section title="Отдельные фрагменты" aside={<span className="tnum">{chunkSources.length}</span>}>
          <ul className="-mx-5 divide-y border-y">
            {chunkSources.map((s, i) => (
              <li key={i} className="px-5 py-2.5">
                {s.chunk_id ? (
                  <ChunkRow id={s.chunk_id} kb={kb} onOpen={onOpen} title={s.title} path={s.path} />
                ) : (
                  <span className="text-[13.5px]">{s.title}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Все разделы в промпте" aside={<span className="tnum">{groups.length} док.</span>}>
        <div className="space-y-2">
          {groups.map(([doc, list]) => (
            <Fold
              key={doc}
              summary={
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate font-medium">{kb?.byDoc.get(doc)?.title ?? doc}</span>
                  {full.has(doc) && (
                    <span className="shrink-0 rounded-md bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                      целиком
                    </span>
                  )}
                  <span className="tnum ml-auto shrink-0 font-mono text-[11.5px] text-muted-foreground">{list.length}</span>
                </span>
              }
            >
              <ol className="space-y-1.5">
                {list.map((id) => (
                  <li key={id}>
                    <button
                      type="button"
                      onClick={() => onOpen(id)}
                      className="text-left text-[13px] leading-snug text-foreground/85 decoration-border underline-offset-[3px] hover:text-foreground hover:underline"
                    >
                      {kb?.byId.get(id)?.chunk.path.split(" > ").pop() ?? id}
                    </button>
                  </li>
                ))}
              </ol>
            </Fold>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ---------- Промпт ----------
function PromptTab({ a }: { a: AnswerPayload }) {
  const [q, setQ] = useState("");
  if (!a.prompt.length) return <Empty>Модель не вызывалась — ответ собран без неё (запасной режим).</Empty>;
  return (
    <div className="space-y-3 p-5">
      <label className="flex h-9 items-center gap-2 rounded-lg border bg-background px-3 text-muted-foreground focus-within:border-ring">
        <ScanSearch className="size-4 shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Найти в промпте"
          aria-label="Найти в промпте"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      {a.prompt.map((m, i) => {
        const count = q.length > 1 ? m.content.toLowerCase().split(q.toLowerCase()).length - 1 : 0;
        return (
          <details key={i} className="group/fold overflow-hidden rounded-xl border" open={i === a.prompt.length - 1}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/fold:rotate-90" />
              <span className="font-mono text-xs font-medium">{m.role}</span>
              <span className="tnum text-muted-foreground">{fmt(m.content.length)} симв.</span>
              {count > 0 && <span className="text-brand-text">· найдено {count}</span>}
              <button
                type="button"
                className="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Скопировать"
                onClick={(e) => {
                  e.preventDefault();
                  void navigator.clipboard.writeText(m.content);
                  toast.success("Скопировано");
                }}
              >
                <Copy className="size-3.5" />
              </button>
            </summary>
            <pre className="max-h-[55vh] overflow-auto border-t bg-surface px-3 py-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
              {q.length > 1 ? highlight(m.content, q) : m.content}
            </pre>
          </details>
        );
      })}
    </div>
  );
}

function highlight(text: string, q: string) {
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((p, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-sm bg-mark text-foreground">
        {p}
      </mark>
    ) : (
      p
    ),
  );
}

// ---------- Проверка ----------
function GuardTab({ a }: { a: AnswerPayload }) {
  const g = a.guard;
  const total = a.timings.total || a.timings.server_total || 1;
  const stages = ["retrieval", "generation", "refine", "guard"].filter((k) => a.timings[k] !== undefined);
  const rows: { ok: boolean; label: string; detail?: string }[] = [
    {
      ok: !g.unknown_numbers?.length,
      label: "Числа только из базы и диалога",
      detail: g.unknown_numbers?.length ? `не найдены в материалах: ${g.unknown_numbers.join(", ")}` : undefined,
    },
    { ok: !g.too_long, label: "Длина ответа в пределах 110 слов" },
  ];
  return (
    <div className="space-y-6 p-5">
      <Section title="Время ответа" aside={<span className="tnum">{(total / 1000).toFixed(2).replace(".", ",")} с</span>}>
        <div className="flex h-2 gap-px overflow-hidden rounded-full bg-muted">
          {stages.map((k) => (
            <div
              key={k}
              className={STAGES[k].color}
              style={{ width: `${(a.timings[k] / total) * 100}%` }}
              title={`${STAGES[k].label}: ${a.timings[k]} мс`}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {stages.map((k) => (
            <span key={k} className="tnum flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", STAGES[k].color)} />
              {STAGES[k].label} {fmt(a.timings[k])} мс
            </span>
          ))}
        </div>
      </Section>
      <Section title="Проверка ответа" aside={<span className="font-mono">energybot/guard.py</span>}>
        <ul className="-mx-5 divide-y border-y">
          {rows.map((r) => (
            <li key={r.label} className="flex items-start gap-2.5 px-5 py-2.5 text-[14px]">
              {r.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              ) : (
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              )}
              <div>
                {r.label}
                {r.detail && <div className="text-[13px] text-destructive">{r.detail}</div>}
              </div>
            </li>
          ))}
        </ul>
        {g.repaired && <Note>Модель переписала ответ по замечанию проверки.</Note>}
        {g.stripped && <Note>Вырезаны предложения с числами: {g.stripped.join(", ")}</Note>}
        {g.dropped && <Note tone="danger">Ответ отброшен целиком — показан запасной ответ из базы.</Note>}
        {a.error && <Note tone="danger">Причина запасного ответа: {a.error}</Note>}
      </Section>
      {a.llm_calls && a.llm_calls.length > 0 && (
        <Section title={`Вызовы модели · ${a.llm_calls.length}`}>
          <div className="space-y-2">
            {a.llm_calls.map((c, i) => (
              <Fold
                key={i}
                summary={
                  <span className="tnum min-w-0 flex-1 truncate">
                    <span className="font-medium">{i === 0 ? "Ответ" : `Вызов ${i + 1}`}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {fmt(c.ms)} мс · промпт {fmt(c.prompt_chars)} симв.
                    </span>
                    {c.error && <span className="text-destructive"> · ошибка</span>}
                  </span>
                }
              >
                <div className="space-y-3 text-[13px] leading-relaxed">
                  {c.instruction && (
                    <div>
                      <div className="mb-0.5 text-xs font-medium text-muted-foreground">Указание модели</div>
                      <p className="whitespace-pre-wrap">{c.instruction}</p>
                    </div>
                  )}
                  <div>
                    <div className="mb-0.5 text-xs font-medium text-muted-foreground">Ответ модели</div>
                    <p className="whitespace-pre-wrap">{c.output || c.error || "—"}</p>
                  </div>
                </div>
              </Fold>
            ))}
          </div>
        </Section>
      )}
      {a.trace && (
        <Section title="Фактическая основа (промежуточный шаг)">
          <pre className="rounded-xl bg-surface p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
            {a.trace}
          </pre>
        </Section>
      )}
    </div>
  );
}

// ---------- панель ----------
export function DebugPanel({
  message,
  question,
  kb,
  onOpenChunk,
  onClose,
}: {
  message?: Message;
  question?: string;
  kb: KbIndex | null;
  onOpenChunk: (id: string) => void;
  onClose?: () => void;
}) {
  const [tab, setTab] = useState("support");
  const a = message?.answer;
  const r = a?.retrieval ?? message?.retrieval ?? null;

  const close = onClose && (
    <button
      type="button"
      onClick={onClose}
      aria-label="Закрыть отладку"
      className="-mr-2 flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <X className="size-4" />
    </button>
  );

  if (!message) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-14 shrink-0 items-center justify-between px-5 text-[15px] font-medium">
          Отладка ответа
          {close}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
          <div className="max-w-[22rem] space-y-2">
            <p className="text-[15px] font-medium">Здесь появится разбор ответа</p>
            <p className="text-[14px] leading-relaxed text-muted-foreground">
              Что нашёл поиск, какие разделы базы ушли модели, полный промпт и на какие факты опирается каждое
              предложение.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const claims = a ? a.citations.filter((c) => !c.question) : [];
  const grounded = claims.filter((c) => c.support.length && !c.unsupported_numbers.length).length;
  const counts: Record<string, string | undefined> = {
    support: a ? `${grounded}/${claims.length}` : undefined,
    search: r ? String(r.hits.length) : undefined,
    context: r ? String(r.context.chunk_ids.length) : undefined,
  };
  const guardFired = a && (a.guard.unknown_numbers?.length || a.guard.too_long || a.guard.stripped || a.guard.dropped);
  const tabs = [
    { value: "support", label: "Опора" },
    { value: "search", label: "Поиск" },
    { value: "context", label: "Контекст" },
    { value: "prompt", label: "Промпт" },
    { value: "guard", label: "Проверка" },
    { value: "json", label: "JSON" },
  ];
  const enabled = (v: string) => (v === "search" ? !!r : !!a);
  const meta = a
    ? [a.model ? a.model.split("/").pop() : "без модели", a.mode === "eval" ? "автопроверка" : "чат", sec(a.timings.server_total)]
    : ["ищу в базе…"];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-5 pt-2.5 pb-4">
        <div className="flex h-10 items-center gap-2">
          <span className="text-[14px] font-semibold">Отладка ответа</span>
          <span className="ml-auto" />
          {close}
        </div>
        {/* Строки, как панель окружения в Claude: иконка и значение, без плашек и рамок. */}
        <ul className="mt-1 space-y-2 text-[13.5px]">
          {question && (
            <li className="flex gap-3">
              <MessageCircleQuestion className="mt-[3px] size-4 shrink-0 text-muted-foreground" aria-label="Вопрос клиента" />
              <p className="line-clamp-2 leading-snug">{question}</p>
            </li>
          )}
          {a ? (
            <li className="flex items-center gap-3">
              <Cpu className="size-4 shrink-0 text-muted-foreground" aria-label="Модель" />
              <span className={cn("truncate", a.model && "font-mono text-[12.5px]")}>{meta[0]}</span>
            </li>
          ) : message.pending ? (
            <li className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
              {r ? "Поиск готов, модель пишет ответ" : "Идёт поиск по базе знаний"}
            </li>
          ) : null}
          {a && (
            <li className="flex items-center gap-3">
              <Timer className="size-4 shrink-0 text-muted-foreground" aria-label="Время и режим" />
              <span className="tnum">{meta[2]}</span>
              <span className="text-muted-foreground">· {meta[1]}</span>
              <span className="ml-auto flex shrink-0 gap-1.5">
                {a.fallback && (
                  <span className="inline-flex h-5 items-center rounded-md bg-warning-soft px-1.5 text-[11px] font-medium text-warning">
                    запасной ответ
                  </span>
                )}
                {guardFired ? (
                  <span className="inline-flex h-5 items-center rounded-md bg-destructive-soft px-1.5 text-[11px] font-medium text-destructive">
                    сработала проверка
                  </span>
                ) : null}
              </span>
            </li>
          )}
        </ul>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 overflow-x-auto border-b px-[13px] max-sm:[mask-image:linear-gradient(to_right,#000_86%,transparent)]">
          <TabsList variant="line" className="h-10 gap-0 p-0">
            {tabs.map((t) => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                disabled={!enabled(t.value)}
                className="h-10 flex-none gap-1 rounded-none px-[7px] text-[13px] text-muted-foreground after:bottom-0! after:bg-foreground data-active:text-foreground"
              >
                {t.label}
                {counts[t.value] && (
                  <span className="tnum font-mono text-[10.5px] font-normal text-muted-foreground">{counts[t.value]}</span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!a && message.pending &&
            (r ? <SearchTab r={r} kb={kb} onOpen={onOpenChunk} /> : <Empty>Идёт поиск по базе знаний…</Empty>)}
          {!a && !message.pending && <Empty>{message.error ?? "Нет данных"}</Empty>}
          {a && (
            <>
              <TabsContent value="support">
                <SupportTab a={a} kb={kb} onOpen={onOpenChunk} />
              </TabsContent>
              <TabsContent value="search">
                {r ? <SearchTab r={r} kb={kb} onOpen={onOpenChunk} /> : <Empty>Поиск не выполнялся</Empty>}
              </TabsContent>
              <TabsContent value="context">
                <ContextTab a={a} r={r} kb={kb} onOpen={onOpenChunk} />
              </TabsContent>
              <TabsContent value="prompt">
                <PromptTab a={a} />
              </TabsContent>
              <TabsContent value="guard">
                <GuardTab a={a} />
              </TabsContent>
              <TabsContent value="json">
                <pre className="p-5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
                  {JSON.stringify(
                    { ...a, prompt: `[${a.prompt.length} сообщ., ${a.prompt_chars} симв. — см. вкладку «Промпт»]` },
                    null,
                    2,
                  )}
                </pre>
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
    </div>
  );
}
