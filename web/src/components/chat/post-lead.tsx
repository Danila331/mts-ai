"use client";

import { CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { useId, useMemo, useState } from "react";
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
  const [open, setOpen] = useState(!!defaultOpen);
  const panelId = useId();
  if (!lead) return null;
  return (
    <div
      className={cn(
        "rounded-2xl border bg-background p-4 shadow-[var(--shadow-float)]",
        compact ? "text-left" : "w-full max-w-[560px] text-left",
      )}
    >
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
      <div className="mt-3 border-t pt-2 pl-11">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[12.5px] text-brand-text focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {LEAD_CHECKLIST_TITLE}
          <ChevronDown
            aria-hidden
            className={cn("size-3.5 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")}
          />
        </button>
        <div
          id={panelId}
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="min-h-0 overflow-hidden" inert={!open}>
            <LeadChecklist session={session} kb={kb} className="pt-2" />
          </div>
        </div>
      </div>
    </div>
  );
}
