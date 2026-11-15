"use client";

import { ArrowLeft, ArrowUpRight, Check, Download } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import type { KbIndex } from "@/hooks/use-kb";
import { type ConsultationSummary, buildSummary, summaryFileTitle } from "@/lib/consultation-summary";
import type { Session } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * «Итоги консультации» (T10). PDF делает сам браузер: «Скачать PDF» → window.print() → «Сохранить как PDF».
 * Документ собирается из сессии в localStorage (src/lib/consultation-summary.ts) и никуда не отправляется:
 * ни серверного рендера с ПДн, ни новых зависимостей. Кириллицу набирает тот же Onest, что и в интерфейсе, —
 * браузер встраивает шрифт в PDF. В печать идёт копия документа в отдельном корне у <body>
 * (globals.css → @media print), поэтому одинаково работает и на стенде, и внутри iframe виджета.
 */

const dateTime = (ts: number) =>
  new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

function KbLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("inline-flex items-baseline gap-0.5 text-brand-text underline-offset-2 hover:underline", className)}
    >
      {children}
      <ArrowUpRight className="size-3 shrink-0 self-center print:hidden" aria-hidden />
    </a>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t pt-5 pb-1">
      <h2 className="mb-3 text-[18px] leading-snug font-semibold break-after-avoid">{title}</h2>
      {children}
    </section>
  );
}

/** Сам документ: одна разметка для превью на экране и для печати. */
export function SummaryDocument({ summary, compact }: { summary: ConsultationSummary; compact?: boolean }) {
  const s = summary;
  return (
    <article className={cn("space-y-5 text-[14px] leading-relaxed text-foreground", compact && "text-[13.5px]")}>
      <header className="space-y-3">
        <BrandLockup />
        <h1 className={cn("leading-tight font-semibold tracking-[-0.025em]", compact ? "text-[24px]" : "text-[30px]")}>
          Итоги консультации
        </h1>
        <p className="text-[13px] text-muted-foreground">
          <span className="tnum">{dateTime(s.updatedAt)}</span>
          {s.leadId && (
            <>
              {" · "}Заявка <span className="tnum font-medium text-foreground">№{s.leadId}</span>
            </>
          )}
        </p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Собрано из разговора с ИИ-консультантом МТС EnergyTool: ваши сообщения, ответы консультанта и разделы базы
          знаний, на которые они опираются. Цифры по вашему объекту подтвердит специалист.
        </p>
      </header>

      <Section title="Что обсуждали">
        <ol className="list-decimal space-y-1.5 pl-5 marker:text-muted-foreground">
          {s.questions.map((q, i) => (
            <li key={i} className="pl-1 break-words">
              {q}
            </li>
          ))}
        </ol>
        {s.moreQuestions > 0 && (
          <p className="mt-1.5 text-[13px] text-muted-foreground">и ещё вопросов: {s.moreQuestions}</p>
        )}
      </Section>

      <Section title="Задача — со слов клиента">
        {s.passport.length ? (
          <dl className="divide-y">
            {s.passport.map((f) => (
              <div key={f.key} className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)] gap-4 py-1.5 break-inside-avoid">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="break-words">{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground">Подробности об объекте в разговоре пока не прозвучали.</p>
        )}
      </Section>

      <Section title="Какие решения обсуждали">
        {s.products.length ? (
          <div className="space-y-5">
            {s.products.map((p) => (
              <div key={p.key} className="break-inside-avoid">
                <h3 className="text-[15.5px] font-semibold">{p.label}</h3>
                {p.docTitle !== p.label && <p className="text-[13px] text-muted-foreground">{p.docTitle}</p>}
                {p.facts.length ? (
                  <ul className="mt-2 space-y-2.5">
                    {p.facts.map((f, i) => (
                      <li key={i} className="border-l-2 border-brand pl-3">
                        <p>{f.text}</p>
                        <p className="mt-0.5 text-[12px] text-muted-foreground">
                          Источник:{" "}
                          {f.sources.map((src, j) => (
                            <span key={src.chunkId}>
                              {j > 0 && "; "}
                              <KbLink href={src.href}>
                                {src.section} · {src.docTitle}
                              </KbLink>
                            </span>
                          ))}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1.5 text-[13px] text-muted-foreground">
                    Консультант ссылался на этот продукт; подробности — в базе знаний МТС EnergyTool.
                  </p>
                )}
              </div>
            ))}
            <p className="text-[12px] text-muted-foreground">
              Цитаты — дословно из ответов консультанта, у каждой — раздел базы знаний, на который она опирается.
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground">Конкретный продукт в разговоре пока не определился.</p>
        )}
      </Section>

      <Section title="Что подготовить для расчёта">
        <p className="mb-3">{s.checklistNote}</p>
        <div className="space-y-4">
          {s.checklists.map((c) => (
            <div key={c.key} className="break-inside-avoid">
              <h3 className="mb-1.5 text-[14.5px] font-semibold">
                <KbLink href={c.href} className="text-foreground">
                  {c.heading}
                </KbLink>
              </h3>
              <ul className="space-y-1">
                {c.items.map((item) => (
                  <li key={item.text} className="flex items-start gap-2.5">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input",
                        item.provided && "border-tone-success bg-tone-success text-white",
                      )}
                    >
                      {item.provided && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span>
                      {item.text}
                      {item.provided && <span className="text-[12px] text-muted-foreground"> — уже есть в разговоре</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {c.notes.length > 0 && <p className="mt-2 text-[13px] text-muted-foreground">{c.notes.join(" ")}</p>}
            </div>
          ))}
        </div>
      </Section>

      {s.leadId && (
        <Section title="Заявка">
          <p>
            Заявка <span className="tnum font-medium">№{s.leadId}</span> передана менеджеру МТС EnergyTool вместе с
            паспортом задачи.
          </p>
        </Section>
      )}

      <Section title="Важно">
        <div className="space-y-1.5 text-[13px] break-inside-avoid">
          <p>{s.disclaimer.intro}</p>
          <p>
            {s.disclaimer.lead} {s.disclaimer.points.join("; ")}.
          </p>
          <p>{s.disclaimer.timing}</p>
          <p className="text-[12px] text-muted-foreground">
            Источник:{" "}
            <KbLink href={s.disclaimer.href}>База знаний МТС EnergyTool · Бесплатная предварительная оценка</KbLink>
          </p>
        </div>
      </Section>
    </article>
  );
}

/** Экран итогов поверх чата: превью документа, «Скачать PDF» и копия для печати в корне <body>. */
export function SummaryPanel({
  session,
  kb,
  onClose,
  compact,
}: {
  session: Session;
  kb: KbIndex | null;
  onClose: () => void;
  compact?: boolean;
}) {
  const summary = useMemo(() => buildSummary(session, kb?.data), [session, kb]);
  const back = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    back.current?.focus();
  }, []);

  const print = () => {
    // Имя файла в «Сохранить как PDF» браузер берёт из заголовка страницы.
    const prev = document.title;
    document.title = summaryFileTitle(summary);
    const restore = () => {
      document.title = prev;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  };

  return (
    <div
      className="msg-in absolute inset-0 z-20 flex flex-col bg-background"
      role="region"
      aria-label="Итоги консультации"
    >
      <div className={cn("flex h-14 shrink-0 items-center gap-2 border-b", compact ? "px-3" : "px-4")}>
        <Button ref={back} variant="ghost" size={compact ? "sm" : "default"} onClick={onClose} className="-ml-1 text-muted-foreground">
          <ArrowLeft /> К чату
        </Button>
        <div className="min-w-0 flex-1" />
        <Button onClick={print} size={compact ? "sm" : "default"}>
          <Download /> Скачать PDF
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto w-full", compact ? "px-4 pt-4 pb-8" : "max-w-[720px] px-5 pt-6 pb-12 sm:px-6")}>
          <p className="mb-5 rounded-lg bg-surface px-3 py-2 text-[12.5px] leading-snug text-muted-foreground">
            «Скачать PDF» откроет окно печати — выберите «Сохранить как PDF». Документ собирается в браузере и никуда
            не отправляется; контакты в него не попадают.
          </p>
          <SummaryDocument summary={summary} compact={compact} />
        </div>
      </div>
      {createPortal(
        <div className="eb-print-root" aria-hidden>
          <SummaryDocument summary={summary} />
        </div>,
        document.body,
      )}
    </div>
  );
}
