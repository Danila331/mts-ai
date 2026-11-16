"use client";

import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  CircleAlert,
  Compass,
  Headset,
  ListChecks,
  MessageSquare,
  RotateCcw,
  X,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { KbIndex } from "@/hooks/use-kb";
import { cn } from "@/lib/utils";
import {
  type KbRef,
  type WizardAnswers,
  type WizardFlow,
  type WizardStep,
  answer,
  evaluate,
  kbChunkId,
  kbDocTitle,
  kbRefHref,
  maxSteps,
  nextStep,
  unanswer,
  visibleSteps,
} from "@/lib/wizards/engine";

/**
 * Мастер на движке T7: шаги по одному, итог с направлениями, цитатами и ссылками на разделы базы.
 * Логика и тексты — в `@/lib/wizards`; здесь только отрисовка, поэтому любой сценарий из `flows/` работает
 * с этим компонентом без правок.
 */

function questions(n: number) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} вопрос`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} вопроса`;
  return `${n} вопросов`;
}

/** Кнопка входа в мастер — в пустом чате стенда и виджета. */
export function WizardEntry({ flow, onStart, compact }: { flow: WizardFlow; onStart: () => void; compact?: boolean }) {
  const label = `${flow.title} за ${questions(maxSteps(flow, {}))}`;
  if (compact) {
    return (
      <button
        type="button"
        onClick={onStart}
        className="group flex w-full items-center gap-3 rounded-2xl border bg-background px-3.5 py-2.5 text-left transition-colors hover:border-input hover:bg-muted"
      >
        <Compass className="size-[18px] shrink-0 text-brand-text" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] leading-snug font-medium">{label}</span>
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">Направления по базе знаний и почему</span>
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onStart}
      title={flow.subtitle}
      className="inline-flex h-9 items-center gap-2 rounded-full border bg-background px-4 text-[13.5px] font-medium shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors hover:bg-muted dark:bg-card"
    >
      <Compass className="size-4 text-brand-text" strokeWidth={1.75} aria-hidden />
      {label}
    </button>
  );
}

/** Ссылка на раздел базы: в стенде открывает раздел сбоку, в виджете — /kb в новой вкладке. */
function KbLink({ refTo, kb, onOpenChunk }: { refTo: KbRef; kb: KbIndex | null; onOpenChunk: (id: string) => void }) {
  const docs = kb?.data.docs;
  const id = kbChunkId(docs, refTo);
  // Пока база не загрузилась — имя файла: «Следующий шаг» без документа ничего не говорит.
  const doc = kbDocTitle(docs, refTo) ?? refTo.doc.split("/").pop();
  const body = (
    <>
      <BookOpen className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="font-medium">{refTo.section}</span>
        {doc && <span className="text-muted-foreground"> · {doc}</span>}
      </span>
    </>
  );
  const cls = "inline-flex max-w-full items-start gap-1.5 text-left text-[12.5px] leading-snug text-brand-text hover:underline [&_svg]:mt-0.5";
  if (id) {
    return (
      <button type="button" className={cls} onClick={() => onOpenChunk(id)}>
        {body}
      </button>
    );
  }
  return (
    <a className={cls} href={kbRefHref(docs, refTo)} target="_blank" rel="noopener">
      {body}
    </a>
  );
}

function Progress({ index, total }: { index: number; total: number }) {
  return (
    <div className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={cn("h-1 flex-1 rounded-full", i <= index ? "bg-foreground" : "bg-muted")} />
      ))}
    </div>
  );
}

function StepView({
  step,
  current,
  onAnswer,
  compact,
}: {
  step: WizardStep;
  current?: { option: string; text?: string };
  onAnswer: (option: string, text?: string) => void;
  compact?: boolean;
}) {
  // Шаг с полем «уточните» не уходит по клику на вариант: сначала выбор, потом «Далее».
  const [draft, setDraft] = useState(current?.option ?? "");
  const [text, setText] = useState(current?.text ?? "");
  const inputId = `wizard-${step.id}-input`;
  return (
    <fieldset className="min-w-0">
      <legend className={cn("font-semibold tracking-[-0.015em]", compact ? "text-[16px]" : "text-[19px] leading-snug")}>
        {step.title}
      </legend>
      {step.hint && <p className="mt-1.5 text-[13px] leading-relaxed text-pretty text-muted-foreground">{step.hint}</p>}
      <ul className={cn("mt-4 grid gap-1.5", !compact && step.options.length > 5 && "sm:grid-cols-2")}>
        {step.options.map((o) => {
          const selected = step.input ? draft === o.id : current?.option === o.id;
          return (
            <li key={o.id}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => (step.input ? setDraft(o.id) : onAnswer(o.id))}
                className={cn(
                  "flex h-full w-full flex-col items-start rounded-xl border bg-background px-3.5 py-2.5 text-left transition-colors hover:border-input hover:bg-muted",
                  selected && "border-foreground hover:border-foreground",
                )}
              >
                <span className="text-[14px] leading-snug">{o.label}</span>
                {o.hint && <span className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">{o.hint}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {step.input && (
        <form
          className="mt-4 grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft) onAnswer(draft, text);
          }}
        >
          <label htmlFor={inputId} className="text-[12.5px] text-muted-foreground">
            {step.input.label}
          </label>
          <div className="flex gap-2">
            <Input
              id={inputId}
              value={text}
              maxLength={120}
              onChange={(e) => setText(e.target.value)}
              placeholder={step.input.placeholder}
              className="min-w-0 flex-1"
            />
            <Button type="submit" disabled={!draft}>
              Далее
            </Button>
          </div>
        </form>
      )}
    </fieldset>
  );
}

/** Итог мастера: направления с «почему», оговорки и ответы. Без действий — для свёрнутой записи в ленте. */
export function WizardResultView({
  flow,
  answers,
  kb,
  onOpenChunk,
  onEdit,
  compact,
}: {
  flow: WizardFlow;
  answers: WizardAnswers;
  kb: KbIndex | null;
  onOpenChunk: (id: string) => void;
  onEdit?: (stepId: string) => void;
  compact?: boolean;
}) {
  const result = evaluate(flow, answers);
  return (
    <div className="grid gap-5">
      <ol className="grid gap-4">
        {result.outcomes.map((o, i) => (
          <li key={o.id} className="flex gap-3">
            <span className="tnum mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-background">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <h3 className={cn("font-semibold leading-snug", compact ? "text-[14.5px]" : "text-[16px]")}>{o.title}</h3>
              <p className="mt-1 text-[14px] leading-relaxed text-pretty">{o.why}</p>
              <blockquote className="mt-2 border-l-2 border-border pl-3 text-[13px] leading-relaxed text-muted-foreground">
                «{o.quote}»
              </blockquote>
              <div className="mt-1.5">
                <KbLink refTo={o.source} kb={kb} onOpenChunk={onOpenChunk} />
              </div>
            </div>
          </li>
        ))}
      </ol>

      {result.notes.length > 0 && (
        <section aria-label="Важно знать" className="border-t pt-4">
          <h3 className="text-[12.5px] font-medium text-muted-foreground">Важно знать</h3>
          <ul className="mt-2 grid gap-3">
            {result.notes.map((n) => (
              <li key={n.id} className="flex gap-2.5">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                <div className="min-w-0">
                  <p className="text-[13.5px] leading-relaxed text-pretty">{n.text}</p>
                  <div className="mt-1">
                    <KbLink refTo={n.source} kb={kb} onOpenChunk={onOpenChunk} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Ваши ответы" className="border-t pt-4">
        <h3 className="text-[12.5px] font-medium text-muted-foreground">Ваши ответы</h3>
        <dl className="mt-2 grid gap-1.5">
          {result.summary.map((s) => (
            <div key={s.step} className="grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_auto] items-baseline gap-3 text-[13px]">
              <dt className="text-muted-foreground">{s.label}</dt>
              <dd className="min-w-0">{s.answer}</dd>
              {onEdit ? (
                <button
                  type="button"
                  onClick={() => onEdit(s.step)}
                  className="text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  Изменить
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

/**
 * Мастер целиком. Ответы живут здесь до конца; наружу уходят только по кнопкам итога: «Продолжить в чате»
 * и «Передать менеджеру» — тогда ответы попадают в паспорт и в чат.
 */
export function WizardRunner({
  flow,
  kb,
  onOpenChunk,
  onClose,
  onFinish,
  compact,
}: {
  flow: WizardFlow;
  kb: KbIndex | null;
  onOpenChunk: (id: string) => void;
  onClose: () => void;
  onFinish: (answers: WizardAnswers, intent: "continue" | "handoff") => void;
  compact?: boolean;
}) {
  const [answers, setAnswers] = useState<WizardAnswers>({});
  // Порядок ответов — для «Назад»: снимаем последний данный ответ.
  const [trail, setTrail] = useState<string[]>([]);
  const step = nextStep(flow, answers);
  const visible = visibleSteps(flow, answers);
  // Всего — самый длинный путь при текущих ответах: до первого ответа видна только развилка.
  const total = step ? maxSteps(flow, answers) : visible.length;
  const index = step ? visible.findIndex((s) => s.id === step.id) : visible.length;

  const respond = (option: string, text?: string) => {
    if (!step) return;
    setAnswers((a) => answer(a, step.id, { option, text }));
    setTrail((t) => [...t.filter((id) => id !== step.id), step.id]);
  };
  const back = () => {
    const last = trail.at(-1);
    if (!last) return onClose();
    setAnswers((a) => unanswer(a, last));
    setTrail((t) => t.slice(0, -1));
  };
  const edit = (stepId: string) => {
    setAnswers((a) => unanswer(a, stepId));
    setTrail((t) => t.filter((id) => id !== stepId));
  };
  const restart = () => {
    setAnswers({});
    setTrail([]);
  };

  return (
    <section aria-label={flow.title} className="msg-in">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" onClick={back} aria-label={trail.length ? "Назад" : "Закрыть"} className="-ml-2 text-muted-foreground">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-[13px] font-medium">{flow.title}</span>
            <span className="tnum shrink-0 text-xs text-muted-foreground">
              {step ? `Вопрос ${index + 1} из ${total}` : "Готово"}
            </span>
          </div>
          <div className="mt-1.5">
            <Progress index={step ? index : total} total={total} />
          </div>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть подбор" className="-mr-2 text-muted-foreground">
          <X />
        </Button>
      </div>

      <div className={cn(compact ? "mt-4" : "mt-6")}>
        {step ? (
          <StepView key={step.id} step={step} current={answers[step.id]} onAnswer={respond} compact={compact} />
        ) : (
          <div className="msg-in">
            <h2 className={cn("font-semibold tracking-[-0.015em]", compact ? "text-[16px]" : "text-[19px] leading-snug")}>
              Что стоит обсудить
            </h2>
            <p className="mt-1.5 mb-5 text-[13px] leading-relaxed text-pretty text-muted-foreground">
              По вашим ответам и базе знаний МТС EnergyTool. Это направление, а не расчёт: эффект для объекта покажет
              бесплатная предварительная оценка специалиста.
            </p>
            <WizardResultView flow={flow} answers={answers} kb={kb} onOpenChunk={onOpenChunk} onEdit={edit} compact={compact} />
            <div className={cn("mt-6 flex flex-wrap items-center gap-2", compact && "grid")}>
              <Button onClick={() => onFinish(answers, "continue")} size={compact ? "lg" : "default"}>
                <MessageSquare /> Продолжить в чате
              </Button>
              <Button variant="outline" onClick={() => onFinish(answers, "handoff")} size={compact ? "lg" : "default"}>
                <Headset /> Передать менеджеру
              </Button>
              <Button variant="ghost" onClick={restart} className="text-muted-foreground" size={compact ? "lg" : "default"}>
                <RotateCcw /> Пройти заново
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              Ответы попадут в паспорт задачи — их можно поправить. Менеджер увидит их вместе с диалогом.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/** Свёрнутый итог мастера в начале диалога: что подобрали и почему, по клику — целиком. */
export function WizardSummary({
  flow,
  answers,
  kb,
  onOpenChunk,
  compact,
}: {
  flow: WizardFlow;
  answers: WizardAnswers;
  kb: KbIndex | null;
  onOpenChunk: (id: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const titles = evaluate(flow, answers).outcomes.map((o) => o.title);
  return (
    <div className={cn("rounded-2xl border bg-background", compact ? "px-3 py-2" : "px-4 py-2.5")}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 text-left"
      >
        <ListChecks className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium">{flow.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{titles.join(" · ")}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="msg-in mt-3 border-t pt-4 pb-2">
          <WizardResultView flow={flow} answers={answers} kb={kb} onOpenChunk={onOpenChunk} compact={compact} />
        </div>
      )}
    </div>
  );
}
