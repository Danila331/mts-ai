"use client";

import { ArrowUpRight, Headset } from "lucide-react";
import { DEGRADED_TITLE, degradedHref, degradedSections } from "@/lib/degraded";
import type { AnswerPayload } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * «Вот что есть в материалах» (T30) под ответом, когда модель недоступна: 2–3 раздела базы, найденные поиском
 * без модели, и кнопка заявки — заявка тоже работает без неё. Тексты разделов — дословно из базы.
 */
export function DegradedSections({
  answer,
  onOpenChunk,
  onLead,
  compact,
}: {
  answer?: AnswerPayload;
  onOpenChunk: (chunkId: string) => void;
  onLead?: () => void;
  compact?: boolean;
}) {
  if (!answer?.degraded) return null;
  const sections = degradedSections(answer);
  return (
    <section
      aria-label={DEGRADED_TITLE}
      className={cn(
        "mt-3.5 space-y-3 rounded-xl bg-surface ring-1 ring-border",
        compact ? "px-3.5 py-3 text-[13px]" : "px-4 py-3.5 text-[14px]",
      )}
    >
      {sections.length > 0 && (
        <ul className="space-y-3">
          {sections.map((s, i) => {
            const last = s.path.split(" > ").pop() || s.path;
            return (
              <li key={s.chunk_id} className={cn("space-y-1", i > 0 && "border-t pt-3")}>
                <a
                  href={degradedHref(s)}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    onOpenChunk(s.chunk_id);
                  }}
                  className="inline-flex items-baseline gap-0.5 font-medium text-brand-text underline-offset-2 hover:underline"
                >
                  {s.title && last !== s.title ? `${s.title} › ${last}` : last || s.title}
                  <ArrowUpRight className="size-3.5 shrink-0 translate-y-[2px]" aria-hidden />
                </a>
                <p className="leading-relaxed text-muted-foreground">{s.excerpt}</p>
              </li>
            );
          })}
        </ul>
      )}
      {onLead && (
        <button
          type="button"
          onClick={onLead}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3.5 text-[13px] font-medium transition-colors hover:bg-muted dark:bg-card"
        >
          <Headset className="size-3.5 text-brand-text" aria-hidden /> Передать запрос менеджеру
        </button>
      )}
    </section>
  );
}
