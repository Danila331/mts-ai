"use client";

import { CheckCircle2, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import type { KbIndex } from "@/hooks/use-kb";
import { LEAD_CHECKLIST_TITLE, LEAD_CONTINUES, LEAD_SERVICE_NOTE, leadAcceptedTitle, leadChecklists } from "@/lib/answer-ux";
import type { Session } from "@/lib/types";
import { cn } from "@/lib/utils";

/** «Что подготовить»: пункты раздела базы «Какие сведения могут понадобиться» под продукт, ещё не названные клиентом. */
export function LeadChecklist({ session, kb, className }: { session: Session; kb?: KbIndex | null; className?: string }) {
  const lists = useMemo(() => leadChecklists(session, kb?.data), [session, kb]);
  if (!lists.length) return null;
  return (
    <div className={cn("text-[13px] leading-snug", className)}>
      <div className="mb-1.5 font-semibold">{LEAD_CHECKLIST_TITLE}</div>
      {lists.map((list) => (
        <div key={list.key} className="mb-2 last:mb-0">
          <div className="text-xs text-muted-foreground">{list.heading}</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 marker:text-muted-foreground">
            {list.items.map((i) => (
              <li key={i.text}>{i.text}</li>
            ))}
          </ul>
          {list.notes.map((n) => (
            <p key={n} className="mt-1 text-xs text-muted-foreground">
              {n}
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * После заявки (T31) вместо кнопки «Передать запрос»: номер, «менеджер свяжется, учитывая удобное время» (без срока),
 * что подготовить и пометка, что консультация продолжается. Форма заново не предлагается — при повторном визите
 * заявка берётся из сессии. defaultOpen — сразу после отправки; потом блок свёрнут.
 */
export function PostLeadCard({
  session,
  kb,
  onOpen,
  defaultOpen,
  compact,
}: {
  session: Session;
  kb?: KbIndex | null;
  onOpen?: () => void;
  defaultOpen?: boolean;
  compact?: boolean;
}) {
  const lead = session.lead;
  if (!lead) return null;
  return (
    <div className={cn("rounded-[18px] border bg-surface px-3 py-2.5", compact ? "text-left" : "w-full max-w-[560px] text-left")}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-tone-success text-white">
          <CheckCircle2 className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] leading-tight font-medium">{leadAcceptedTitle(lead.id)}</div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
            {LEAD_SERVICE_NOTE} {LEAD_CONTINUES}
          </p>
        </div>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            aria-label="Что получит менеджер"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <ChevronRight className="size-4" />
          </button>
        )}
      </div>
      <details open={defaultOpen} className="group mt-2 pl-11">
        <summary className="cursor-pointer text-[12.5px] text-brand-text select-none">{LEAD_CHECKLIST_TITLE}</summary>
        <LeadChecklist session={session} kb={kb} className="mt-2" />
      </details>
    </div>
  );
}
