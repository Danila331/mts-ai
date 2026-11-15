"use client";

import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Copy,
  Cpu,
  FileText,
  Loader2,
  MessageSquareText,
  ScanSearch,
  ShieldCheck,
  SquareTerminal,
  Timer,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { citationOrder, SourceNumber } from "@/components/chat/answer-text";
import type { KbIndex } from "@/hooks/use-kb";
import { getSettings } from "@/lib/api";
import type { AnswerPayload, Citation, Hit, Message, Retrieval } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * Разбор ответа — как правая панель сессии в Claude Code: одна прокрутка, секции с заголовками,
 * строки «иконка — подпись — значение справа», сегментная полоса с легендой, сворачиваемые группы со счётчиком.
 * Цвет — только у категорий данных (документы, этапы) и у проблем; всё остальное — графит и серые.
 */

const fmt = (n: number) => n.toLocaleString("ru");
const sec = (ms: number) => `${(ms / 1000).toFixed(1).replace(".", ",")} с`;
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(".", ",").replace(",0", "")}k` : String(n));

const SWATCH = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5", "bg-chart-6"];

const STAGES: Record<string, { label: string; color: string }> = {
  retrieval: { label: "Поиск", color: "bg-chart-1" },
  generation: { label: "Генерация", color: "bg-chart-2" },
  refine: { label: "Доработка", color: "bg-chart-4" },
  guard: { label: "Проверка", color: "bg-chart-3" },
};

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

// ---------- кирпичи ----------

function Section({
  title,
  aside,
  children,
  defaultOpen = true,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b px-4 py-3.5 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group/sec -mx-1 flex h-7 w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <h3 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h3>
        <ChevronRight
          className={cn(
            "size-3.5 text-muted-foreground/60 transition-[transform,color] group-hover/sec:text-foreground",
            open && "rotate-90",
          )}
        />
        {aside && <span className="tnum ml-auto truncate text-[12px] text-muted-foreground">{aside}</span>}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}

/** Строка «иконка — подпись — значение справа». */
function Row({
  icon: Icon,
  label,
  children,
  mono,
}: {
  icon?: React.ElementType;
  label: React.ReactNode;
  children?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2.5 text-[13px]">
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="min-w-0 truncate">{label}</span>
      {children !== undefined && (
        <span className={cn("tnum ml-auto shrink-0 text-muted-foreground", mono && "font-mono text-[12px]")}>{children}</span>
      )}
    </div>
  );
}

/** Сворачиваемая группа: «› Кандидаты   30». */
function Group({
  label,
  count,
  icon: Icon,
  defaultOpen,
  children,
}: {
  label: React.ReactNode;
  count?: React.ReactNode;
  icon?: React.ElementType;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-mx-1 flex min-h-7 w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 text-left text-[13px] outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")}
        />
        {Icon && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
        <span className="min-w-0 truncate">{label}</span>
        {count !== undefined && <span className="tnum ml-auto shrink-0 font-mono text-[12px] text-muted-foreground">{count}</span>}
      </button>
      {open && <div className="mt-1 mb-2 ml-[7px] border-l pl-3.5">{children}</div>}
    </div>
  );
}

/** Сегментная полоса, как «Context 4% used»: доли по категориям, остаток — дорожка. */
function SegmentBar({ parts, total }: { parts: { value: number; color: string; label: string }[]; total: number }) {
  return (
    <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted" aria-hidden>
      {parts.map((p, i) => (
        <span
          key={i}
          className={cn("h-full first:rounded-l-full", p.color)}
          style={{ width: `${Math.max(0.6, (p.value / Math.max(total, 1)) * 100)}%` }}
          title={p.label}
        />
      ))}
    </div>
  );
}

/** Строка легенды: цветной квадрат, подпись, значение и доля справа. */
function Legend({
  color,
  label,
  value,
  share,
  onClick,
  tag,
}: {
  color: string;
  label: React.ReactNode;
  value: React.ReactNode;
  share?: string;
  onClick?: () => void;
  tag?: React.ReactNode;
}) {
  const body = (
    <>
      <span className={cn("size-2.5 shrink-0 rounded-[3px]", color)} aria-hidden />
      <span
        className={cn(
          "min-w-0 truncate",
          onClick && "underline decoration-border decoration-dotted underline-offset-[3px] group-hover/leg:decoration-foreground",
        )}
      >
        {label}
      </span>
      {tag}
      <span className="tnum ml-auto shrink-0 font-mono text-[12px] text-muted-foreground">{value}</span>
      {share && <span className="tnum w-10 shrink-0 text-right font-mono text-[12px] text-muted-foreground">{share}</span>}
    </>
  );
  const cls = "group/leg flex min-h-7 w-full items-center gap-2.5 text-left text-[13px]";
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, "outline-none focus-visible:ring-2 focus-visible:ring-ring/50")}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Note({ tone = "warning", children }: { tone?: "warning" | "danger"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "mt-2 flex items-start gap-2 rounded-md px-2.5 py-2 text-[12px] leading-snug",
        tone === "warning" ? "bg-warning-soft text-warning" : "bg-destructive-soft text-destructive",
      )}
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{children}</p>;
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-[4px] bg-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground">{children}</span>
  );
}

function sectionOf(kb: KbIndex | null, id: string, path?: string) {
  return (path ?? kb?.byId.get(id)?.chunk.path ?? id).split(" > ").pop() ?? id;
}

/** Ссылка на раздел базы: название раздела, документ приглушённо; клик открывает раздел. */
function ChunkLink({
  id,
  kb,
  onOpen,
  path,
  title,
  className,
}: {
  id: string;
  kb: KbIndex | null;
  onOpen: (id: string) => void;
  path?: string;
  title?: string;
  className?: string;
}) {
  const section = sectionOf(kb, id, path);
  const doc = title ?? kb?.byId.get(id)?.doc.title;
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      title={`#${id}`}
      className={cn("group/ck min-w-0 truncate text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)}
    >
      <span className="underline decoration-transparent underline-offset-[3px] transition-colors group-hover/ck:decoration-border">
        {section}
      </span>
      {doc && doc !== section && <span className="text-muted-foreground"> · {doc}</span>}
    </button>
  );
}

// ---------- Ответ ----------

function AnswerSection({ a, question, message }: { a?: AnswerPayload; question?: string; message: Message }) {
  const r = a?.retrieval ?? message.retrieval;
  const total = a ? a.timings.total || a.timings.server_total || 1 : 0;
  const stages = a ? ["retrieval", "generation", "refine", "guard"].filter((k) => a.timings[k] !== undefined) : [];
  const g = a?.guard;
  const fired = !!g && !!(g.unknown_numbers?.length || g.too_long || g.stripped || g.dropped);
  return (
    <Section title="Ответ" aside={a ? sec(a.timings.server_total) : undefined}>
      {question && <p className="mb-2 line-clamp-3 text-[13px] leading-relaxed text-pretty">{question}</p>}
      {a ? (
        <>
          <Row icon={Cpu} label="Модель" mono>
            {a.model ? a.model.split("/").pop() : "без модели"}
          </Row>
          <Row icon={MessageSquareText} label="Режим">
            {a.mode === "eval" ? "как на проверке" : "чат"}
          </Row>
          <Row icon={ShieldCheck} label="Проверка">
            <span className={cn("inline-flex items-center gap-1.5", (fired || a.fallback) && "text-destructive")}>
              <span className={cn("size-1.5 rounded-full", fired || a.fallback ? "bg-destructive" : "bg-success")} />
              {a.fallback ? "запасной ответ" : fired ? "сработала" : "пройдена"}
            </span>
          </Row>
          <div className="mt-3 space-y-0.5">
            <Row icon={Timer} label="Время по этапам" mono>
              {sec(total)}
            </Row>
            <div className="py-1.5">
              <SegmentBar
                total={total}
                parts={stages.map((k) => ({ value: a.timings[k], color: STAGES[k].color, label: STAGES[k].label }))}
              />
            </div>
            {stages.map((k) => (
              <Legend
                key={k}
                color={STAGES[k].color}
                label={STAGES[k].label}
                value={`${fmt(a.timings[k])} мс`}
                share={`${Math.round((a.timings[k] / total) * 100)}%`}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="flex min-h-7 items-center gap-2.5 text-[13px] text-muted-foreground">
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
          {r ? "Поиск готов, модель пишет ответ" : "Идёт поиск по базе знаний"}
        </div>
      )}
    </Section>
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
  strong: { label: "опора найдена", bar: "bg-foreground/75", icon: <CheckCircle2 className="size-4 text-foreground/70" /> },
  weak: { label: "слабая опора", bar: "bg-foreground/30", icon: <CheckCircle2 className="size-4 text-muted-foreground/60" /> },
  none: { label: "без опоры", bar: "bg-warning", icon: <AlertTriangle className="size-4 text-warning" /> },
  numbers: { label: "числа без опоры", bar: "bg-destructive", icon: <AlertTriangle className="size-4 text-destructive" /> },
  question: { label: "вопрос клиенту", bar: "bg-dim", icon: <CircleHelp className="size-4 text-muted-foreground" /> },
};

function SupportSection({ a, kb, onOpen }: { a: AnswerPayload; kb: KbIndex | null; onOpen: (id: string) => void }) {
  const order = citationOrder(a);
  const verdicts = a.citations.map(verdict);
  const claims = verdicts.filter((v) => v !== "question").length;
  const grounded = verdicts.filter((v) => v === "strong" || v === "weak").length;
  const loose = a.citations.reduce((n, c) => n + c.unsupported_numbers.length, 0);

  return (
    <Section title="Опора на базу" aside={`${grounded} из ${claims} ${plural(claims, "утверждения", "утверждений", "утверждений")}`}>
      <div className="flex h-1.5 gap-[3px]" aria-hidden>
        {verdicts.map((v, i) => (
          <span key={i} className={cn("flex-1 rounded-full", VERDICT[v].bar)} title={VERDICT[v].label} />
        ))}
      </div>
      <div className="tnum mt-2 flex flex-wrap gap-x-3 text-[12px] text-muted-foreground">
        <span>источников {order.length}</span>
        <span className={cn(loose > 0 && "text-destructive")}>чисел без опоры {loose}</span>
      </div>

      <ol className="mt-3 space-y-3">
        {a.citations.map((c, i) => {
          const v = verdicts[i];
          return (
            <li key={i} className="grid grid-cols-[16px_1fr] gap-x-2.5">
              <span className="pt-0.5" title={VERDICT[v].label}>
                {VERDICT[v].icon}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] leading-relaxed text-pretty">{c.sentence}</p>
                {c.question ? (
                  <p className="mt-0.5 text-[12px] text-muted-foreground">Уточняющий вопрос — опора не нужна</p>
                ) : c.support.length ? (
                  <ul className="mt-1">
                    {c.support.map((s) => {
                      const pct = Math.round(s.overlap * 100);
                      return (
                        <li key={s.id} className="flex min-h-6 items-center gap-2">
                          <SourceNumber n={order.indexOf(s.id) + 1} />
                          <ChunkLink id={s.id} kb={kb} onOpen={onOpen} path={s.path} title={s.title} className="flex-1 text-[12px]" />
                          <span
                            className={cn(
                              "tnum shrink-0 font-mono text-[11px]",
                              pct >= 50 ? "text-foreground/80" : "text-muted-foreground",
                            )}
                            title="совпадение слов и чисел"
                          >
                            {pct}%
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="mt-0.5 text-[12px] text-warning">Не нашлось раздела с похожей формулировкой</p>
                )}
                {c.unsupported_numbers.length > 0 && (
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-[12px] text-destructive">
                    Числа без опоры:
                    {c.unsupported_numbers.map((n) => (
                      <span key={n} className="tnum rounded-[4px] bg-destructive-soft px-1 font-mono text-[11px]">
                        {n}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <Hint>
        Эвристика стенда: предложение сопоставлено с разделами контекста по совпадению основ слов и чисел. Модель
        источники не размечает — по регламенту ответ идёт одной строкой.
      </Hint>
    </Section>
  );
}

// ---------- Контекст ----------

function ContextSection({
  a,
  r,
  kb,
  onOpen,
  budget,
}: {
  a?: AnswerPayload;
  r: Retrieval;
  kb: KbIndex | null;
  onOpen: (id: string) => void;
  budget?: number;
}) {
  const ids = r.context.chunk_ids;
  const full = useMemo(() => new Set(r.context.full_docs), [r]);
  // Символы по документам — по текстам разделов из базы: доли совпадают с тем, что ушло модели.
  const docs = useMemo(() => {
    const map = new Map<string, { doc: string; title: string; ids: string[]; chars: number }>();
    for (const id of ids) {
      const e = kb?.byId.get(id);
      const key = e?.doc.doc ?? "?";
      const row = map.get(key) ?? { doc: key, title: e?.doc.title ?? key, ids: [], chars: 0 };
      row.ids.push(id);
      row.chars += e?.chunk.text.length ?? 0;
      map.set(key, row);
    }
    return [...map.values()].sort((x, y) => y.chars - x.chars);
  }, [ids, kb]);
  const measured = docs.reduce((n, d) => n + d.chars, 0) || 1;
  const chars = r.context.chars;
  // Полные документы могут выйти за бюджет — тогда полоса заполнена, а процент честно больше 100.
  const cap = Math.max(budget ?? 0, chars);
  const top = docs.slice(0, 5);
  const rest = docs.slice(5);
  const restChars = rest.reduce((n, d) => n + d.chars, 0);
  // Доля каждого документа — от фактического размера контекста, остаток до бюджета — дорожка.
  const scale = chars / measured;
  const parts = [
    ...top.map((d, i) => ({ value: d.chars * scale, color: SWATCH[i], label: d.title })),
    ...(rest.length ? [{ value: restChars * scale, color: "bg-dim", label: "остальные" }] : []),
  ];
  const docSources = a?.sources.filter((s) => s.kind === "doc") ?? [];
  const chunkSources = a?.sources.filter((s) => s.kind !== "doc") ?? [];

  return (
    <Section title="Контекст модели" aside={`${ids.length} ${plural(ids.length, "раздел", "раздела", "разделов")}`}>
      <div className="flex items-baseline justify-between text-[13px]">
        <span className={cn(budget && chars > budget && "text-warning")}>
          {budget ? `${Math.round((chars / budget) * 100)}% бюджета` : "Ушло модели"}
        </span>
        <span className="tnum font-mono text-[12px] text-muted-foreground">
          {short(chars)}
          {budget ? ` / ${short(budget)}` : ""} симв.
        </span>
      </div>
      <div className="py-2">
        <SegmentBar total={cap} parts={parts} />
      </div>
      {top.map((d, i) => (
        <Legend
          key={d.doc}
          color={SWATCH[i]}
          label={d.title}
          tag={full.has(d.doc) ? <Tag>целиком</Tag> : undefined}
          value={`${d.ids.length} разд.`}
          share={`${Math.round((d.chars / measured) * 100)}%`}
          onClick={() => onOpen(d.ids[0])}
        />
      ))}
      {rest.length > 0 && (
        <Legend
          color="bg-dim"
          label={`Ещё ${rest.length} ${plural(rest.length, "документ", "документа", "документов")}`}
          value={`${rest.reduce((n, d) => n + d.ids.length, 0)} разд.`}
          share={`${Math.round((restChars / measured) * 100)}%`}
        />
      )}

      <div className="mt-2">
        {docSources.length > 0 && (
          <Group label="Документы целиком" count={docSources.length} icon={FileText}>
            {docSources.map((s, i) => (
              <div key={i} className="flex min-h-7 items-center">
                {s.chunk_id ? (
                  <ChunkLink id={s.chunk_id} kb={kb} onOpen={onOpen} path={s.title} />
                ) : (
                  <span className="text-[13px]">{s.title}</span>
                )}
              </div>
            ))}
          </Group>
        )}
        {chunkSources.length > 0 && (
          <Group label="Отдельные фрагменты" count={chunkSources.length} icon={FileText}>
            {chunkSources.map((s, i) => (
              <div key={i} className="flex min-h-7 items-center">
                {s.chunk_id ? (
                  <ChunkLink id={s.chunk_id} kb={kb} onOpen={onOpen} title={s.title} path={s.path} />
                ) : (
                  <span className="text-[13px]">{s.title}</span>
                )}
              </div>
            ))}
          </Group>
        )}
        <Group label="Все разделы по документам" count={docs.length}>
          {docs.map((d) => (
            <Group key={d.doc} label={d.title} count={d.ids.length}>
              {d.ids.map((id) => (
                <div key={id} className="flex min-h-6 items-center">
                  <ChunkLink id={id} kb={kb} onOpen={onOpen} title="" className="text-[12px]" />
                </div>
              ))}
            </Group>
          ))}
        </Group>
      </div>
      <Hint>
        {full.size
          ? "Самые релевантные документы уходят целиком, остальные — лучшими фрагментами, плюс справочник: карта продуктов, числа, границы консультации."
          : "Лучшие фрагменты поиска, соседние разделы главного документа и ограничения по найденным продуктам."}
      </Hint>
    </Section>
  );
}

// ---------- Поиск ----------

function SearchSection({ r, kb, onOpen }: { r: Retrieval; kb: KbIndex | null; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<"all" | "in" | "out">("all");
  const inContext = r.hits.filter((h) => h.in_context).length;
  const hits = r.hits.filter((h) => (filter === "all" ? true : filter === "in" ? h.in_context : !h.in_context));
  const max = Math.max(...r.hits.map((h) => h.score ?? 0));
  const stage = r.hits[0]?.stage;
  return (
    <Section title="Поиск по базе" aside={<span className="font-mono text-[12px]">{[stage, r.dense ? "bm25 + эмбеддинги" : "bm25"].filter(Boolean).join(" · ")}</span>}>
      <p className="text-[13px] leading-relaxed text-pretty">{r.queries.semantic || "—"}</p>
      <div className="mt-2">
        {r.queries.lexical && (
          <Group label="Лексический запрос (BM25)" icon={ScanSearch}>
            <p className="py-1 font-mono text-[11px] leading-relaxed text-muted-foreground">{r.queries.lexical}</p>
          </Group>
        )}
        <Group label="Кандидаты" count={`${inContext} / ${r.hits.length}`} defaultOpen>
          <div className="mb-1.5 flex gap-1 pt-1" role="radiogroup" aria-label="Какие кандидаты показать">
            {(
              [
                ["all", "Все", r.hits.length],
                ["in", "В контексте", inContext],
                ["out", "Отброшены", r.hits.length - inContext],
              ] as const
            ).map(([value, label, count]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                  filter === value && "bg-muted text-foreground",
                )}
              >
                {label}
                <span className="tnum font-mono text-[11px] text-muted-foreground">{count}</span>
              </button>
            ))}
          </div>
          <ol>
            {hits.map((h: Hit) => {
              const pct = max > 0 && h.score !== null ? Math.max(4, (h.score / max) * 100) : 0;
              return (
                <li key={h.id} className={cn("flex min-h-7 items-center gap-2.5", !h.in_context && "opacity-60 hover:opacity-100")}>
                  <span className="tnum w-5 shrink-0 font-mono text-[11px] text-muted-foreground">{String(h.rank).padStart(2, "0")}</span>
                  <span
                    className={cn("size-1.5 shrink-0 rounded-full", h.in_context ? "bg-chart-1" : "bg-dim")}
                    title={h.in_context ? "ушёл модели" : "отброшен"}
                  />
                  <ChunkLink id={h.id} kb={kb} onOpen={onOpen} title={h.title} path={h.path} className="flex-1 text-[12px]" />
                  <span className="relative h-1 w-8 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span
                      className={cn("absolute inset-y-0 left-0 rounded-full", h.in_context ? "bg-chart-1" : "bg-dim")}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="tnum w-12 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                    {h.score === null ? "—" : h.score < 0.1 ? h.score.toFixed(4) : h.score.toFixed(3)}
                  </span>
                </li>
              );
            })}
          </ol>
          {!hits.length && <p className="py-1 text-[12px] text-muted-foreground">Пусто</p>}
        </Group>
      </div>
    </Section>
  );
}

// ---------- Проверка ----------

function GuardSection({ a }: { a: AnswerPayload }) {
  const g = a.guard;
  const rows: { ok: boolean; label: string; detail?: string }[] = [
    {
      ok: !g.unknown_numbers?.length,
      label: "Числа только из базы и диалога",
      detail: g.unknown_numbers?.length ? `не найдены в материалах: ${g.unknown_numbers.join(", ")}` : undefined,
    },
    { ok: !g.too_long, label: "Длина ответа в пределах 110 слов" },
  ];
  return (
    <Section title="Проверка ответа" aside={<span className="font-mono text-[12px]">guard.py</span>}>
      {rows.map((r) => (
        <div key={r.label} className="flex min-h-7 items-start gap-2.5 py-1 text-[13px]">
          {r.ok ? (
            <CheckCircle2 className="mt-px size-4 shrink-0 text-muted-foreground" />
          ) : (
            <AlertTriangle className="mt-px size-4 shrink-0 text-destructive" />
          )}
          <div className="min-w-0">
            {r.label}
            {r.detail && <div className="text-[12px] text-destructive">{r.detail}</div>}
          </div>
        </div>
      ))}
      {g.repaired && <Note>Модель переписала ответ по замечанию проверки.</Note>}
      {g.stripped && <Note>Вырезаны предложения с числами: {g.stripped.join(", ")}</Note>}
      {g.dropped && <Note tone="danger">Ответ отброшен целиком — показан запасной ответ из базы.</Note>}
      {a.error && <Note tone="danger">Причина запасного ответа: {a.error}</Note>}
      {((a.llm_calls?.length ?? 0) > 0 || a.trace) && (
        <div className="mt-2">
          {a.llm_calls && a.llm_calls.length > 0 && (
            <Group label="Вызовы модели" count={a.llm_calls.length} icon={Cpu}>
              {a.llm_calls.map((c, i) => (
                <Group
                  key={i}
                  label={
                    <>
                      {i === 0 ? "Ответ" : `Вызов ${i + 1}`}
                      {c.error && <span className="text-destructive"> · ошибка</span>}
                    </>
                  }
                  count={`${fmt(c.ms)} мс`}
                >
                  <div className="space-y-2 py-1 text-[12px] leading-relaxed">
                    {c.instruction && (
                      <div>
                        <div className="text-[11px] font-medium text-muted-foreground">Указание модели</div>
                        <p className="whitespace-pre-wrap">{c.instruction}</p>
                      </div>
                    )}
                    <div>
                      <div className="text-[11px] font-medium text-muted-foreground">
                        Ответ модели · промпт {fmt(c.prompt_chars)} симв.
                      </div>
                      <p className="whitespace-pre-wrap">{c.output || c.error || "—"}</p>
                    </div>
                  </div>
                </Group>
              ))}
            </Group>
          )}
          {a.trace && (
            <Group label="Фактическая основа" icon={FileText}>
              <pre className="py-1 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{a.trace}</pre>
            </Group>
          )}
        </div>
      )}
    </Section>
  );
}

// ---------- Промпт и JSON ----------

function highlight(text: string, q: string) {
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((p, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-[2px] bg-mark text-foreground">
        {p}
      </mark>
    ) : (
      p
    ),
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <button
      type="button"
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        toast.success("Скопировано");
      }}
    >
      <Copy className="size-3.5" />
    </button>
  );
}

function RawSection({ a }: { a: AnswerPayload }) {
  const [q, setQ] = useState("");
  const json = useMemo(
    () =>
      JSON.stringify({ ...a, prompt: `[${a.prompt.length} сообщ., ${a.prompt_chars} симв. — см. «Промпт»]` }, null, 2),
    [a],
  );
  return (
    <Section title="Сырые данные" aside={`промпт ${short(a.prompt_chars)} симв.`} defaultOpen>
      {a.prompt.length ? (
        <Group label="Промпт" count={a.prompt.length} icon={SquareTerminal}>
          <label className="mt-1 mb-2 flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-muted-foreground focus-within:border-ring">
            <ScanSearch className="size-3.5 shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Найти в промпте"
              aria-label="Найти в промпте"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          {a.prompt.map((m, i) => {
            const count = q.length > 1 ? m.content.toLowerCase().split(q.toLowerCase()).length - 1 : 0;
            return (
              <Group
                key={i}
                defaultOpen={i === a.prompt.length - 1}
                label={
                  <span className="font-mono text-[12px]">
                    {m.role}
                    {count > 0 && <span className="font-sans font-medium text-foreground"> · найдено {count}</span>}
                  </span>
                }
                count={`${fmt(m.content.length)} симв.`}
              >
                <div className="relative">
                  <div className="absolute top-1 right-0">
                    <CopyButton text={m.content} label={`Скопировать ${m.role}`} />
                  </div>
                  <pre className="max-h-[50vh] overflow-auto rounded-md bg-surface py-2 pr-8 pl-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                    {q.length > 1 ? highlight(m.content, q) : m.content}
                  </pre>
                </div>
              </Group>
            );
          })}
        </Group>
      ) : (
        <Row icon={SquareTerminal} label="Модель не вызывалась — запасной режим" />
      )}
      <Group label="JSON ответа API" icon={Braces}>
        <div className="relative">
          <div className="absolute top-1 right-0">
            <CopyButton text={json} label="Скопировать JSON" />
          </div>
          <pre className="max-h-[50vh] overflow-auto rounded-md bg-surface py-2 pr-8 pl-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {json}
          </pre>
        </div>
      </Group>
    </Section>
  );
}

// ---------- панель ----------

/** Бюджет контекста из настроек RAG — чтобы полоса показывала «N% бюджета», как «Context 4% used». */
function useContextBudget() {
  const [budget, setBudget] = useState<number>();
  useEffect(() => {
    let alive = true;
    getSettings()
      .then((s) => {
        const v = s.values.context_chars;
        if (alive && typeof v === "number") setBudget(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return budget;
}

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
  const budget = useContextBudget();
  const a = message?.answer;
  const r = a?.retrieval ?? message?.retrieval ?? null;

  const header = (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <h2 className="text-[14px] font-medium">Разбор ответа</h2>
      {message?.pending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="ответ готовится" />}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть разбор ответа"
          className="-mr-1.5 ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );

  if (!message) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16 text-center">
          <p className="text-[14px] font-medium">Здесь появится разбор ответа</p>
          <p className="mt-1.5 max-w-[22rem] text-[13px] leading-relaxed text-muted-foreground">
            Что нашёл поиск, какие разделы ушли модели, на что опирается каждое предложение и что поймала проверка.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnswerSection a={a} question={question} message={message} />
        {a && <SupportSection a={a} kb={kb} onOpen={onOpenChunk} />}
        {r && <ContextSection a={a} r={r} kb={kb} onOpen={onOpenChunk} budget={budget} />}
        {r && <SearchSection r={r} kb={kb} onOpen={onOpenChunk} />}
        {a && <GuardSection a={a} />}
        {a && <RawSection a={a} />}
        {!a && !message.pending && (
          <p className="px-4 py-6 text-[13px] text-muted-foreground">{message.error ?? "Нет данных"}</p>
        )}
      </div>
    </div>
  );
}
