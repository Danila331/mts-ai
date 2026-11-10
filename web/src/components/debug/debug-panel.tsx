"use client";

import { AlertTriangle, Bug, CheckCircle2, Copy, FileText, Layers, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { citationOrder } from "@/components/chat/answer-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { KbIndex } from "@/hooks/use-kb";
import type { AnswerPayload, Hit, Message, Retrieval } from "@/lib/types";
import { cn } from "@/lib/utils";

const STAGE_COLORS: Record<string, string> = {
  retrieval: "bg-sky-500",
  generation: "bg-brand",
  refine: "bg-violet-500",
  guard: "bg-amber-500",
};
const STAGE_LABELS: Record<string, string> = {
  retrieval: "Поиск",
  generation: "Генерация",
  refine: "Доработка",
  guard: "Проверка",
};

function ChunkLink({ id, kb, onOpen, children }: {
  id: string;
  kb: KbIndex | null;
  onOpen: (id: string) => void;
  children?: React.ReactNode;
}) {
  const e = kb?.byId.get(id);
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      className="text-left text-xs leading-snug hover:text-brand hover:underline"
      title={`#${id}`}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">{e?.doc.title ?? "?"} › </span>
          {e?.chunk.path ?? id}
        </>
      )}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-muted-foreground">{children}</div>;
}

// ---------- Опора ----------
function SupportTab({ a, kb, onOpen }: { a: AnswerPayload; kb: KbIndex | null; onOpen: (id: string) => void }) {
  const order = citationOrder(a);
  return (
    <div className="space-y-3 p-4">
      <p className="text-xs text-muted-foreground">
        Каждое предложение ответа сопоставлено с разделами из контекста модели по совпадению основ слов и чисел.
        Это эвристика стенда: модель не размечает источники сама (ответ по регламенту — одна строка без разметки).
      </p>
      {a.citations.map((c, i) => (
        <div key={i} className="rounded-lg border p-3">
          <p className="text-sm leading-relaxed">{c.sentence}</p>
          {c.question ? (
            <div className="mt-2 text-xs text-muted-foreground">Уточняющий вопрос клиенту — опора не нужна</div>
          ) : c.support.length ? (
            <ul className="mt-2 space-y-1.5">
              {c.support.map((s) => (
                <li key={s.id} className="flex items-start gap-2">
                  <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[10px] font-semibold text-brand">
                    {order.indexOf(s.id) + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <ChunkLink id={s.id} kb={kb} onOpen={onOpen} />
                    <div className="mt-0.5 flex items-center gap-2">
                      <div className="h-1 w-20 overflow-hidden rounded-full bg-muted">
                        <div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, s.overlap * 100)}%` }} />
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        совпадение {Math.round(s.overlap * 100)}%
                        {s.numbers.length ? ` · числа: ${s.numbers.join(", ")}` : ""}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-3.5" /> Не нашлось раздела с похожей формулировкой
            </div>
          )}
          {c.unsupported_numbers.length > 0 && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600">
              <AlertTriangle className="size-3.5" /> Числа без опоры в разделах: {c.unsupported_numbers.join(", ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------- Поиск ----------
function ScoreBar({ hit, max }: { hit: Hit; max: number }) {
  const v = hit.score ?? 0;
  const pct = max > 0 ? Math.max(4, (v / max) * 100) : 0;
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full", hit.in_context ? "bg-sky-500" : "bg-muted-foreground/40")} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-12 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {hit.score === null ? "—" : v < 0.1 ? v.toFixed(4) : v.toFixed(3)}
      </span>
    </div>
  );
}

function SearchTab({ r, kb, onOpen }: { r: Retrieval; kb: KbIndex | null; onOpen: (id: string) => void }) {
  const [onlyContext, setOnlyContext] = useState(false);
  const hits = onlyContext ? r.hits.filter((h) => h.in_context) : r.hits;
  const max = Math.max(...r.hits.map((h) => h.score ?? 0));
  const stage = r.hits[0]?.stage;
  return (
    <div className="space-y-3 p-4">
      <div className="grid gap-2 text-xs">
        <div>
          <div className="mb-0.5 font-medium text-muted-foreground">Смысловой запрос (эмбеддинги{stage === "rerank" ? ", реранкер" : ""})</div>
          <div className="rounded-md bg-muted px-2 py-1.5">{r.queries.semantic}</div>
        </div>
        <details>
          <summary className="cursor-pointer font-medium text-muted-foreground">Лексический запрос (BM25)</summary>
          <div className="mt-1 rounded-md bg-muted px-2 py-1.5">{r.queries.lexical}</div>
        </details>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5 text-xs">
          <Badge variant="secondary">схема {r.arch}</Badge>
          <Badge variant="secondary">{r.dense ? "BM25 + эмбеддинги" : "только BM25"}</Badge>
          <Badge variant="secondary">ранжирование: {stage}</Badge>
        </div>
        <button
          type="button"
          onClick={() => setOnlyContext((v) => !v)}
          className={cn("rounded-md px-2 py-0.5 text-xs", onlyContext ? "bg-sky-100 text-sky-800" : "text-muted-foreground hover:bg-muted")}
        >
          только в контексте
        </button>
      </div>
      <ol className="divide-y rounded-lg border">
        {hits.map((h) => (
          <li key={h.id} className="flex items-start gap-2 px-2.5 py-2">
            <span className="w-5 shrink-0 pt-0.5 text-right font-mono text-[10px] text-muted-foreground">{h.rank}</span>
            <div className="min-w-0 flex-1">
              <ChunkLink id={h.id} kb={kb} onOpen={onOpen}>
                <span className="text-muted-foreground">{h.title} › </span>
                {h.path}
              </ChunkLink>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{h.preview}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <ScoreBar hit={h} max={max} />
              {h.in_context ? (
                <span className="text-[10px] text-sky-700 dark:text-sky-400">в контексте</span>
              ) : (
                <span className="text-[10px] text-muted-foreground/70">отброшен</span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------- Контекст ----------
function ContextTab({ a, r, kb, onOpen }: {
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
    return [...map.entries()];
  }, [ids, kb]);
  const full = new Set(r?.context.full_docs ?? []);
  return (
    <div className="space-y-3 p-4">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="разделов" value={ids.length} />
        <Stat label="документов целиком" value={full.size} />
        <Stat label="символов материалов" value={(r?.context.chars ?? 0).toLocaleString("ru")} />
      </div>
      <p className="text-xs text-muted-foreground">
        {full.size
          ? "Самые релевантные документы — целиком (эталон часто опирается на соседние разделы), плюс лучшие фрагменты остальных и справочник: карта продуктов, числа, границы консультации."
          : "Лучшие фрагменты поиска, соседние разделы главного документа и ограничения («можно / нельзя утверждать») по найденным продуктам."}
      </p>
      {a.sources.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium">Материалы по вопросу</div>
          {a.sources.map((s, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <Badge variant={s.kind === "doc" ? "default" : "outline"} className="h-4 px-1 text-[10px]">
                {s.kind === "doc" ? "документ" : "фрагмент"}
              </Badge>
              {s.chunk_id ? (
                <ChunkLink id={s.chunk_id} kb={kb} onOpen={onOpen}>
                  {s.title}
                  {s.path && <span className="text-muted-foreground"> › {s.path}</span>}
                </ChunkLink>
              ) : (
                s.title
              )}
            </div>
          ))}
        </div>
      )}
      <div className="space-y-2">
        <div className="text-xs font-medium">Все разделы в промпте</div>
        {groups.map(([doc, list]) => (
          <details key={doc} className="rounded-lg border px-3 py-2" open={full.has(doc)}>
            <summary className="cursor-pointer text-xs">
              <span className="font-medium">{kb?.byDoc.get(doc)?.title ?? doc}</span>
              <span className="text-muted-foreground"> · {list.length} разд.{full.has(doc) ? " · целиком" : ""}</span>
            </summary>
            <ul className="mt-1.5 space-y-1 pl-1">
              {list.map((id) => (
                <li key={id}>
                  <ChunkLink id={id} kb={kb} onOpen={onOpen}>
                    {kb?.byId.get(id)?.chunk.path ?? id}
                  </ChunkLink>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg border px-2.5 py-2">
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

// ---------- Промпт ----------
function PromptTab({ a }: { a: AnswerPayload }) {
  const [q, setQ] = useState("");
  if (!a.prompt.length) return <Empty>Модель не вызывалась — ответ собран без неё (запасной режим).</Empty>;
  return (
    <div className="space-y-3 p-4">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Найти в промпте…" className="h-8 text-xs" />
      {a.prompt.map((m, i) => {
        const count = q.length > 1 ? m.content.toLowerCase().split(q.toLowerCase()).length - 1 : 0;
        return (
          <details key={i} className="rounded-lg border" open={i === a.prompt.length - 1}>
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs">
              <Badge variant="secondary" className="font-mono">{m.role}</Badge>
              <span className="text-muted-foreground">{m.content.length.toLocaleString("ru")} симв.</span>
              {count > 0 && <span className="text-brand">· найдено {count}</span>}
              <Button
                variant="ghost"
                size="icon-xs"
                className="ml-auto"
                onClick={(e) => {
                  e.preventDefault();
                  void navigator.clipboard.writeText(m.content);
                  toast.success("Скопировано");
                }}
              >
                <Copy />
              </Button>
            </summary>
            <pre className="max-h-[50vh] overflow-auto border-t bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
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
  return parts.map((p, i) => (i % 2 ? <mark key={i} className="bg-yellow-200">{p}</mark> : p));
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
    <div className="space-y-4 p-4">
      <div>
        <div className="mb-1.5 flex items-baseline justify-between text-xs">
          <span className="font-medium">Время ответа</span>
          <span className="tabular-nums text-muted-foreground">{(total / 1000).toFixed(2)} c</span>
        </div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
          {stages.map((k) => (
            <div
              key={k}
              className={STAGE_COLORS[k]}
              style={{ width: `${(a.timings[k] / total) * 100}%` }}
              title={`${STAGE_LABELS[k]}: ${a.timings[k]} мс`}
            />
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          {stages.map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className={cn("size-2 rounded-full", STAGE_COLORS[k])} />
              {STAGE_LABELS[k]} {a.timings[k]} мс
            </span>
          ))}
        </div>
      </div>
      <div className="space-y-2">
        <div className="text-xs font-medium">Проверка ответа (energybot/guard.py)</div>
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-2 text-sm">
            {r.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 text-red-600" />
            )}
            <div>
              {r.label}
              {r.detail && <div className="text-xs text-red-600">{r.detail}</div>}
            </div>
          </div>
        ))}
        {g.repaired && <Note>Модель переписала ответ по замечанию проверки.</Note>}
        {g.stripped && <Note>Вырезаны предложения с числами: {g.stripped.join(", ")}</Note>}
        {g.dropped && <Note>Ответ отброшен целиком — показан запасной ответ из базы.</Note>}
        {a.error && <Note>Причина запасного ответа: {a.error}</Note>}
      </div>
      {a.llm_calls && a.llm_calls.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium">Вызовы модели: {a.llm_calls.length}</div>
          {a.llm_calls.map((c, i) => (
            <details key={i} className="rounded-lg border px-3 py-2 text-xs">
              <summary className="cursor-pointer">
                <span className="font-medium">{i === 0 ? "Ответ" : `Вызов ${i + 1}`}</span>
                <span className="text-muted-foreground">
                  {" "}· {c.ms} мс · промпт {c.prompt_chars.toLocaleString("ru")} симв.
                </span>
                {c.error && <span className="text-red-600"> · ошибка</span>}
              </summary>
              {c.instruction && (
                <div className="mt-2">
                  <div className="text-[10px] text-muted-foreground uppercase">Указание модели</div>
                  <p className="whitespace-pre-wrap">{c.instruction}</p>
                </div>
              )}
              <div className="mt-2">
                <div className="text-[10px] text-muted-foreground uppercase">Ответ модели</div>
                <p className="whitespace-pre-wrap">{c.output || c.error || "—"}</p>
              </div>
            </details>
          ))}
        </div>
      )}
      {a.trace && (
        <div className="space-y-1">
          <div className="text-xs font-medium">Фактическая основа (промежуточный шаг)</div>
          <pre className="rounded-lg bg-muted p-2 text-[11px] whitespace-pre-wrap">{a.trace}</pre>
        </div>
      )}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{children}</div>;
}

// ---------- панель ----------
export function DebugPanel({
  message,
  question,
  kb,
  onOpenChunk,
}: {
  message?: Message;
  question?: string;
  kb: KbIndex | null;
  onOpenChunk: (id: string) => void;
}) {
  const [tab, setTab] = useState("support");
  const a = message?.answer;
  const r = a?.retrieval ?? message?.retrieval ?? null;

  if (!message) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
        <Bug className="size-8 text-muted-foreground/50" />
        <div className="font-medium text-foreground">Отладка ответа</div>
        Задайте вопрос — здесь появится, что нашёл поиск, какие разделы базы ушли модели, полный промпт и на какие факты
        опирается каждое предложение ответа.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Bug className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Отладка ответа</span>
          {a && (
            <span className="ml-auto flex gap-1">
              <Badge variant="secondary" className="font-mono text-[10px]">{a.model || "без модели"}</Badge>
              <Badge variant="secondary" className="text-[10px]">{a.mode === "eval" ? "автопроверка" : "чат"}</Badge>
            </span>
          )}
        </div>
        {question && <p className="line-clamp-2 text-xs text-muted-foreground">Вопрос: {question}</p>}
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))} className="min-h-0 flex-1 gap-0">
        <div className="shrink-0 overflow-x-auto border-b px-3 py-2">
          <TabsList className="h-8">
            <TabsTrigger value="support" disabled={!a} className="text-xs"><ShieldCheck />Опора</TabsTrigger>
            <TabsTrigger value="search" disabled={!r} className="text-xs"><Search />Поиск</TabsTrigger>
            <TabsTrigger value="context" disabled={!a} className="text-xs"><Layers />Контекст</TabsTrigger>
            <TabsTrigger value="prompt" disabled={!a} className="text-xs"><FileText />Промпт</TabsTrigger>
            <TabsTrigger value="guard" disabled={!a} className="text-xs">Проверка</TabsTrigger>
            <TabsTrigger value="json" disabled={!a} className="text-xs">JSON</TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!a && message.pending && (
            r ? <SearchTab r={r} kb={kb} onOpen={onOpenChunk} /> : <Empty>Идёт поиск по базе знаний…</Empty>
          )}
          {!a && !message.pending && <Empty>{message.error ?? "Нет данных"}</Empty>}
          {a && (
            <>
              <TabsContent value="support"><SupportTab a={a} kb={kb} onOpen={onOpenChunk} /></TabsContent>
              <TabsContent value="search">{r ? <SearchTab r={r} kb={kb} onOpen={onOpenChunk} /> : <Empty>Поиск не выполнялся</Empty>}</TabsContent>
              <TabsContent value="context"><ContextTab a={a} r={r} kb={kb} onOpen={onOpenChunk} /></TabsContent>
              <TabsContent value="prompt"><PromptTab a={a} /></TabsContent>
              <TabsContent value="guard"><GuardTab a={a} /></TabsContent>
              <TabsContent value="json">
                <pre className="p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {JSON.stringify({ ...a, prompt: `[${a.prompt.length} сообщ., ${a.prompt_chars} симв. — см. вкладку «Промпт»]` }, null, 2)}
                </pre>
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
    </div>
  );
}
