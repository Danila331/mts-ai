"use client";

import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { KbIndex } from "@/hooks/use-kb";
import { type GlossaryEntry, type Piece, glossaryHref } from "@/lib/glossary";

/**
 * Термин в ответе бота (T16): подчёркнут пунктиром, по наведению или касанию — определение дословно из базы знаний
 * и ссылка «в базе» на раздел (`/kb?chunk=`, id раздела берётся из /api/kb).
 */
export function GlossaryTerm({ entry, children, kb }: { entry: GlossaryEntry; children: React.ReactNode; kb: KbIndex | null }) {
  const [open, setOpen] = useState(false);
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger
        delay={150}
        render={
          <button
            type="button"
            // Касание на телефоне наведения не даёт: тап открывает подсказку.
            onClick={() => setOpen(true)}
            className="cursor-help rounded-[3px] underline decoration-muted-foreground/70 decoration-dotted decoration-[1.5px] underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50 print:no-underline"
            aria-label={`${entry.term}: подсказка`}
          />
        }
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-80 p-4">
        <div className="space-y-2">
          <div className="text-[14px] leading-snug font-medium">{entry.term}</div>
          <p className="text-[13px] leading-relaxed text-muted-foreground">«{entry.definition}»</p>
          <a
            href={glossaryHref(entry, kb?.data)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-text hover:underline"
          >
            В базе: {entry.section} <ArrowUpRight className="size-3.5" />
          </a>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** Предложение ответа с подчёркнутыми терминами: куски уже разобраны ({@link markTerms}) родителем. */
export function TermText({ pieces, kb }: { pieces: Piece[]; kb: KbIndex | null }) {
  return (
    <>
      {pieces.map((p, i) =>
        p.entry ? (
          <GlossaryTerm key={i} entry={p.entry} kb={kb}>
            {p.text}
          </GlossaryTerm>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
