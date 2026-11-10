"use client";

import { ExternalLink } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { KbIndex } from "@/hooks/use-kb";
import type { AnswerPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Номера источников по порядку первого упоминания — как сноски в Perplexity. */
export function citationOrder(answer: AnswerPayload | undefined): string[] {
  const order: string[] = [];
  for (const c of answer?.citations ?? []) {
    if (c.question) continue;
    for (const s of c.support.slice(0, 2)) if (!order.includes(s.id)) order.push(s.id);
  }
  return order;
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
  const entry = kb?.byId.get(id);
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={120}
        render={
          <button
            type="button"
            onClick={() => onOpen(id)}
            className="mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-0.5 items-center justify-center rounded-full bg-brand-soft px-1 align-middle text-[10px] font-semibold text-brand transition hover:bg-brand hover:text-white"
            aria-label={`Источник ${n}`}
          />
        }
      >
        {n}
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-80 p-3">
        {entry ? (
          <div className="space-y-1.5">
            <div className="text-[11px] text-muted-foreground">{entry.doc.title}</div>
            <div className="text-sm font-medium leading-snug">{entry.chunk.path}</div>
            <p className="line-clamp-5 text-xs leading-relaxed text-muted-foreground">{entry.chunk.text}</p>
            <button
              type="button"
              onClick={() => onOpen(id)}
              className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
            >
              Открыть в базе знаний <ExternalLink className="size-3" />
            </button>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">Раздел #{id}</div>
        )}
      </HoverCardContent>
    </HoverCard>
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
      {answer.citations.map((c, i) => (
        <span key={i}>
          {c.sentence}
          {!c.question &&
            c.support.slice(0, 2).map((s) => (
              <SourceChip key={s.id} id={s.id} n={order.indexOf(s.id) + 1} kb={kb} onOpen={onOpenChunk} />
            ))}
          {i < answer.citations.length - 1 ? " " : ""}
        </span>
      ))}
    </p>
  );
}
