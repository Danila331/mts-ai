"use client";

import { ArrowUpRight, CircleSlash } from "lucide-react";
import {
  HONEST_NO_ALSO,
  HONEST_NO_LEAD,
  HONEST_NO_TITLE,
  honestNoItems,
  sameProductAsPrevious,
  sectionHref,
  sectionLabel,
} from "@/lib/honest-no";
import type { AnswerPayload, HonestNoSection } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Ссылка на раздел базы: обычный переход по /kb?chunk=…, а простой клик — как у источников ответа. */
function SectionLink({
  section,
  onOpen,
  children,
}: {
  section: HonestNoSection;
  onOpen: (chunkId: string) => void;
  children: React.ReactNode;
}) {
  return (
    <a
      href={sectionHref(section)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)
          return;
        e.preventDefault();
        onOpen(section.chunk_id);
      }}
      className="inline-flex items-baseline gap-0.5 font-medium text-brand-text underline-offset-2 hover:underline"
    >
      {children}
      <ArrowUpRight
        className="size-3.5 shrink-0 translate-y-[2px]"
        aria-hidden
      />
    </a>
  );
}

/**
 * Плашка «Честно: не подойдёт» (T26) под ответом: продукт, причина словами базы, ссылка на раздел и то,
 * что подходит вместо. Правила и тексты — ядро (scripts/honest_no.py), здесь только показ.
 */
export function HonestNoNotice({
  answer,
  onOpenChunk,
  compact,
}: {
  answer?: AnswerPayload;
  onOpenChunk: (chunkId: string) => void;
  compact?: boolean;
}) {
  const items = honestNoItems(answer);
  if (!items.length) return null;
  return (
    <section
      aria-label={HONEST_NO_TITLE}
      className={cn(
        "mt-3.5 space-y-3 rounded-xl bg-warning-soft ring-1 ring-tone-warning/25",
        compact ? "px-3.5 py-3 text-[13px]" : "px-4 py-3.5 text-[14px]",
      )}
    >
      {items.map((item, i) => {
        const same = sameProductAsPrevious(items, i);
        return (
          <div
            key={item.rule}
            className={cn(
              "space-y-1.5 leading-relaxed",
              i > 0 && "border-t border-tone-warning/20 pt-3",
            )}
          >
            {!same && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="inline-flex items-center gap-1.5 font-semibold text-tone-warning">
                  <CircleSlash className="size-4" aria-hidden />
                  {HONEST_NO_TITLE}
                </span>
                <span className="text-foreground/80">· {item.product}</span>
              </div>
            )}
            <p className="text-foreground">
              {same ? HONEST_NO_ALSO : HONEST_NO_LEAD}: {item.reason}
            </p>
            {item.fact && (
              <p className="text-xs text-muted-foreground">
                Из ваших слов: «{item.fact}»
              </p>
            )}
            {item.section && (
              <p className="text-xs text-muted-foreground">
                Основание:{" "}
                <SectionLink section={item.section} onOpen={onOpenChunk}>
                  {sectionLabel(item.section)}
                </SectionLink>
              </p>
            )}
            {item.alternative && (
              <p className="text-foreground">
                <span className="font-medium">Что подойдёт: </span>
                {item.alternative.text}
                {item.alternative.section && (
                  <>
                    {" "}
                    <SectionLink
                      section={item.alternative.section}
                      onOpen={onOpenChunk}
                    >
                      раздел базы
                    </SectionLink>
                  </>
                )}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
