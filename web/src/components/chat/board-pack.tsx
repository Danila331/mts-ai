"use client";

import { Check } from "lucide-react";
import { BrandLockup } from "@/components/brand";
import { type BoardPack, type BoardQuoteView, BOARD_LIMITS_NOTE, BOARD_LIMITS_TITLE, HONEST_NO_TITLE } from "@/lib/board-pack";
import { cn } from "@/lib/utils";
import { KbLink, Section, dateTime } from "./summary-parts";

/** Цитата базы: подпись продукта, текст дословно в кавычках и ссылка на раздел. */
function Quote({ q }: { q: BoardQuoteView }) {
  return (
    <li className="border-l-2 border-brand pl-3 break-inside-avoid">
      {q.label && <p className="text-[12px] font-medium text-muted-foreground">{q.label}</p>}
      <p>«{q.text}»</p>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        Источник: <KbLink href={q.href}>{q.section}</KbLink>
      </p>
    </li>
  );
}

/**
 * «Пакет для правления» (T22): документ для правления СНТ, УК, ТСЖ. Тексты о продукте и его границах — цитаты базы
 * знаний дословно (src/lib/board-pack.ts), без цен, окупаемости и обещаний. Одна разметка для превью и для печати.
 */
export function BoardDocument({ pack, compact }: { pack: BoardPack; compact?: boolean }) {
  const p = pack;
  return (
    <article className={cn("space-y-5 text-[14px] leading-relaxed text-foreground", compact && "text-[13.5px]")}>
      <header className="space-y-3">
        <BrandLockup />
        <h1 className={cn("leading-tight font-semibold tracking-[-0.025em]", compact ? "text-[24px]" : "text-[30px]")}>
          {p.title}
        </h1>
        <p className="text-[15px] text-muted-foreground">{p.subtitle}</p>
        <p className="text-[13px] text-muted-foreground">
          <span className="tnum">{dateTime(p.updatedAt)}</span>
          {p.leadId && (
            <>
              {" · "}Заявка <span className="tnum font-medium text-foreground">№{p.leadId}</span>
            </>
          )}
        </p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{p.intro}</p>
      </header>

      <Section title="Что обсуждали">
        <ol className="list-decimal space-y-1.5 pl-5 marker:text-muted-foreground">
          {p.questions.map((q, i) => (
            <li key={i} className="pl-1 break-words">
              {q}
            </li>
          ))}
        </ol>
        {p.moreQuestions > 0 && <p className="mt-1.5 text-[13px] text-muted-foreground">и ещё вопросов: {p.moreQuestions}</p>}
        {p.passport.length > 0 && (
          <dl className="mt-3 divide-y">
            {p.passport.map((f) => (
              <div key={f.key} className="grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)] gap-4 py-1.5 break-inside-avoid">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd className="break-words">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Section>

      <Section title="Что база знаний говорит о продукте для вашей организации">
        <ul className="space-y-2.5">
          {p.org.map((q, i) => (
            <Quote key={i} q={q} />
          ))}
        </ul>
      </Section>

      <Section title={BOARD_LIMITS_TITLE}>
        <p className="mb-2.5 text-[13px] text-muted-foreground">{BOARD_LIMITS_NOTE}</p>
        <ul className="space-y-2.5">
          {p.limits.map((q, i) => (
            <Quote key={i} q={q} />
          ))}
        </ul>
        {p.honestNo.length > 0 && (
          <div className="mt-4 space-y-2.5">
            <h3 className="text-[14.5px] font-semibold">{HONEST_NO_TITLE}</h3>
            <ul className="space-y-2.5">
              {p.honestNo.map((h) => (
                <li key={h.rule} className="border-l-2 border-tone-warning pl-3 break-inside-avoid">
                  <p className="text-[12px] font-medium text-muted-foreground">{h.product}</p>
                  <p>«{h.reason}»</p>
                  {h.link && (
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      Источник: <KbLink href={h.link.href}>{h.link.text}</KbLink>
                    </p>
                  )}
                  {h.alternative && (
                    <p className="mt-1 text-[13px]">
                      В базе для такой задачи указано: «{h.alternative.text}»
                      {h.alternative.link && (
                        <>
                          {" · "}
                          <KbLink href={h.alternative.link.href}>{h.alternative.link.text}</KbLink>
                        </>
                      )}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="Что подготовить для расчёта">
        <p className="mb-3">{p.checklistNote}</p>
        <div className="space-y-4">
          {p.checklists.map((c) => (
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

      <Section title="Оговорки базы знаний">
        <ul className="space-y-2.5">
          {p.caveats.map((q, i) => (
            <Quote key={i} q={q} />
          ))}
        </ul>
        <div className="mt-3 space-y-1 text-[13px] break-inside-avoid">
          <p className="font-medium">{p.disclaimer.heading}</p>
          <p>
            {p.disclaimer.lead} {p.disclaimer.points.join("; ")}.
          </p>
          <p>{p.disclaimer.timing}</p>
          <p className="text-[12px] text-muted-foreground">
            Источник: <KbLink href={p.disclaimer.href}>{p.disclaimer.heading}</KbLink>
          </p>
        </div>
      </Section>
    </article>
  );
}
