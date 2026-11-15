"use client";

import { ArrowUpRight, BookOpenText, ChevronRight, FileText } from "lucide-react";
import { useState } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { KbIndex } from "@/hooks/use-kb";
import type { AnswerPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Номера источников по порядку первого упоминания — как сноски. */
export function citationOrder(answer: AnswerPayload | undefined): string[] {
  const order: string[] = [];
  for (const c of answer?.citations ?? []) {
    if (c.question) continue;
    for (const s of c.support.slice(0, 2)) if (!order.includes(s.id)) order.push(s.id);
  }
  return order;
}

/** Номер источника — тихая сноска: мягкая красная подложка, при наведении — сплошной красный. */
export function SourceNumber({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn(
        "tnum inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-brand-soft px-[3px] font-mono text-[10px] leading-none font-medium text-brand-text",
        className,
      )}
    >
      {n}
    </span>
  );
}

function SourcePreview({ id, kb, onOpen }: { id: string; kb: KbIndex | null; onOpen: (chunkId: string) => void }) {
  const entry = kb?.byId.get(id);
  if (!entry) return <div className="text-xs text-muted-foreground">Раздел #{id}</div>;
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <FileText className="size-3.5" />
        <span className="truncate">{entry.doc.title}</span>
      </div>
      <div className="mt-1.5 text-[13px] leading-snug font-medium">{entry.chunk.path.split(" > ").pop()}</div>
      <p className="mt-1 line-clamp-4 text-[12px] leading-relaxed text-muted-foreground">{entry.chunk.text}</p>
      <button
        type="button"
        onClick={() => onOpen(id)}
        className="mt-2.5 inline-flex items-center gap-1 text-[12px] font-medium text-foreground underline decoration-border underline-offset-[3px] hover:decoration-foreground"
      >
        Открыть раздел <ArrowUpRight className="size-3.5" />
      </button>
    </div>
  );
}

export function SourceChip({
  id,
  n,
  kb,
  onOpen,
}: {
  id: string;
  n: number;
  kb: KbIndex | null;
  onOpen: (chunkId: string) => void;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={120}
        render={
          <button
            type="button"
            onClick={() => onOpen(id)}
            className="group/chip ml-[3px] inline-flex -translate-y-[2px] align-middle outline-none last:mr-0.5"
            aria-label={`Источник ${n}`}
          />
        }
      >
        <SourceNumber
          n={n}
          className="transition-colors group-hover/chip:bg-brand group-hover/chip:text-brand-foreground group-focus-visible/chip:bg-brand group-focus-visible/chip:text-brand-foreground"
        />
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-80 p-3.5">
        <SourcePreview id={id} kb={kb} onOpen={onOpen} />
      </HoverCardContent>
    </HoverCard>
  );
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/**
 * Источники под ответом — строка, как Sources в агентских чатах: «3 раздела из 1 документа ›».
 * Развёрнуто — список за тонкой линией, каждая строка открывает раздел базы, который видела модель.
 */
export function SourcesRow({
  answer,
  kb,
  onOpen,
}: {
  answer?: AnswerPayload;
  kb: KbIndex | null;
  onOpen: (chunkId: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const order = citationOrder(answer);
  if (!order.length) return null;
  const docs = new Set(order.map((id) => kb?.byId.get(id)?.doc.doc ?? id)).size;
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group/src -ml-1 inline-flex h-7 items-center gap-1.5 rounded-md px-1 text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <BookOpenText className="size-3.5" />
        <span className="tnum">
          {order.length} {plural(order.length, "раздел", "раздела", "разделов")} базы из {docs}{" "}
          {plural(docs, "документа", "документов", "документов")}
        </span>
        <ChevronRight className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} />
      </button>
      {open && (
        <ol className="msg-in mt-1 ml-[7px] border-l pl-3" aria-label="Источники ответа">
          {order.map((id, i) => {
            const entry = kb?.byId.get(id);
            const section = entry ? entry.chunk.path.split(" > ").pop() || entry.doc.title : `#${id}`;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onOpen(id)}
                  className="group/row flex w-full items-center gap-2.5 rounded-md py-1.5 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <SourceNumber n={i + 1} className="group-hover/row:bg-brand group-hover/row:text-brand-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="text-foreground group-hover/row:underline group-hover/row:decoration-border group-hover/row:underline-offset-[3px]">
                      {section}
                    </span>
                    {entry && <span className="text-muted-foreground"> · {entry.doc.title}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

export function AnswerText({
  answer,
  text,
  kb,
  onOpenChunk,
  showCitations = true,
  className,
}: {
  answer?: AnswerPayload;
  text: string;
  kb: KbIndex | null;
  onOpenChunk: (chunkId: string) => void;
  showCitations?: boolean;
  className?: string;
}) {
  if (!answer?.citations?.length || !showCitations) {
    return <p className={cn("whitespace-pre-wrap", className)}>{text}</p>;
  }
  const order = citationOrder(answer);
  return (
    <p className={className}>
      {answer.citations.map((c, i) => {
        const marks = !c.question && c.support.length > 0;
        // Номера приклеены к последнему слову: сноска не уезжает одна в начало следующей строки.
        const cut = marks ? c.sentence.trimEnd().lastIndexOf(" ") + 1 : c.sentence.length;
        return (
          <span key={i}>
            {c.sentence.slice(0, cut)}
            {marks && (
              <span className="whitespace-nowrap">
                {c.sentence.slice(cut).trimEnd()}
                {c.support.slice(0, 2).map((s) => (
                  <SourceChip key={s.id} id={s.id} n={order.indexOf(s.id) + 1} kb={kb} onOpen={onOpenChunk} />
                ))}
              </span>
            )}
            {i < answer.citations.length - 1 ? " " : ""}
          </span>
        );
      })}
    </p>
  );
}
