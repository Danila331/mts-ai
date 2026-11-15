"use client";

import { ClipboardCopy, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { briefHtml, briefText, buildBrief } from "@/lib/meeting-brief";
import type { LeadCard } from "@/lib/manager";

/**
 * «Шпаргалка к встрече» (T25): что спросить, подготовить и чего не обещать. Собирается из заявки и базы знаний без
 * модели (src/lib/meeting-brief.ts); печать — в отдельном окне, копирование — простым текстом.
 */
export function MeetingBrief({ card }: { card: LeadCard }) {
  const brief = buildBrief(card);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(briefText(brief));
      toast.success("Шпаргалка скопирована");
    } catch {
      toast.error("Не удалось скопировать — выделите текст вручную");
    }
  };

  const print = () => {
    const win = window.open("", "_blank");
    if (!win) {
      toast.error("Браузер заблокировал окно печати — разрешите всплывающие окна для стенда");
      return;
    }
    win.document.write(briefHtml(brief));
    win.document.close();
    win.focus();
    win.print();
  };

  return (
    <div id="meeting-brief">
      <div className="mb-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={copy}>
          <ClipboardCopy /> Копировать
        </Button>
        <Button size="sm" variant="outline" onClick={print}>
          <Printer /> Печать
        </Button>
      </div>
      <div className="space-y-4">
        {brief.sections.map((s) => (
          <section key={s.id}>
            <h4 className="text-[14px] font-semibold">{s.title}</h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-[14px]">
              {s.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {s.sources.length > 0 && (
              <p className="mt-1.5 text-[12px] text-muted-foreground">База знаний: {s.sources.join("; ")}</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
