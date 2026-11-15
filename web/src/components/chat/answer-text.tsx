"use client";

import { ArrowUpRight, ChevronDown } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { createHoverCardHandle, HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import type { KbIndex } from "@/hooks/use-kb";
import { safeAnswerText } from "@/lib/answer-links";
import { bestCitationLine, bestLine, textLines } from "@/lib/line-match";
import type { AnswerPayload } from "@/lib/types";
import { cn } from "@/lib/utils";
import { markTerms } from "@/lib/glossary";
import { TermText } from "./glossary-term";

/** Номера источников по порядку первого упоминания — как сноски. */
export function citationOrder(answer: AnswerPayload | undefined): string[] {
  const order: string[] = [];
  for (const c of answer?.citations ?? []) {
    if (c.question) continue;
    for (const s of c.support.slice(0, 2)) if (!order.includes(s.id)) order.push(s.id);
  }
  return order;
}

/** Номер источника: красный, как сноска. */
export function SourceNumber({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn(
        "tnum inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-[5px] bg-primary px-[3px] text-[10.5px] leading-none font-semibold text-white",
        className,
      )}
    >
      {n}
    </span>
  );
}

/** Открыть раздел; hl — строка раздела, на которую опирается ответ (если нашлась). */
export type OpenChunk = (chunkId: string, hl?: number) => void;

interface CitePayload {
  id: string;
  n: number;
  sentence: string;
}

// Задержки карточки: открытие чуть дольше, чтобы случайный проход курсора не вызывал её; закрытие короткое,
// но его хватает, чтобы перевести курсор с чипа на карточку или на соседний чип без мерцания.
const OPEN_DELAY = 180;
const CLOSE_DELAY = 110;

function SourcePreview({
  id,
  sentence,
  kb,
  onOpen,
}: {
  id: string;
  sentence: string;
  kb: KbIndex | null;
  onOpen: OpenChunk;
}) {
  const entry = kb?.byId.get(id);
  if (!entry) return <div className="text-xs text-muted-foreground">Раздел #{id}</div>;
  const match = bestLine(sentence, entry.chunk.text);
  // Если строка нашлась, показываем именно её — то, на что опирается предложение; иначе начало раздела.
  const preview = match ? textLines(entry.chunk.text)[match.line] : entry.chunk.text;
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">{entry.doc.title}</div>
      <div className="text-[14px] leading-snug font-medium">{entry.chunk.path.split(" > ").pop()}</div>
      <p className="line-clamp-5 text-[13px] leading-relaxed text-muted-foreground">{preview}</p>
      <button
        type="button"
        onClick={() => onOpen(id, match?.line)}
        className="inline-flex items-center gap-1 text-[13px] font-medium text-brand-text hover:underline"
      >
        Открыть раздел в базе <ArrowUpRight className="size-3.5" />
      </button>
    </div>
  );
}

export function SourceChip({
  id,
  n,
  sentence,
  kb,
  onOpen,
  handle,
}: {
  id: string;
  n: number;
  sentence: string;
  kb: KbIndex | null;
  onOpen: OpenChunk;
  handle: ReturnType<typeof createHoverCardHandle<CitePayload>>;
}) {
  const triggerId = useId();
  const touch = useRef(false);
  return (
    <HoverCardTrigger
      id={triggerId}
      handle={handle}
      payload={{ id, n, sentence }}
      delay={OPEN_DELAY}
      closeDelay={CLOSE_DELAY}
      render={
        <button
          type="button"
          onPointerDown={(e) => {
            touch.current = e.pointerType === "touch";
          }}
          onClick={() => {
            // На тач-экране наведения нет: тап открывает карточку, повторный тап или тап вне — закрывает.
            if (touch.current) {
              touch.current = false;
              if (handle.isOpen) handle.close();
              else handle.open(triggerId);
              return;
            }
            const entry = kb?.byId.get(id);
            onOpen(id, entry ? bestLine(sentence, entry.chunk.text)?.line : undefined);
          }}
          className="group/chip ml-[3px] inline-flex -translate-y-[1.5px] align-middle outline-none last:mr-0.5"
          aria-label={`Источник ${n}`}
        />
      }
    >
      <SourceNumber
        n={n}
        className="transition-colors group-hover/chip:bg-brand group-hover/chip:text-white group-focus-visible/chip:bg-brand group-focus-visible/chip:text-white"
      />
    </HoverCardTrigger>
  );
}

function plural(n: number) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "источник";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "источника";
  return "источников";
}

/**
 * Источники под ответом: свёрнуто — стопка номеров и счётчик, развёрнуто — список
 * «раздел / документ», каждый пункт открывает раздел базы, который видела модель.
 */
export function SourcesRow({
  answer,
  kb,
  onOpen,
}: {
  answer?: AnswerPayload;
  kb: KbIndex | null;
  onOpen: OpenChunk;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const order = citationOrder(answer);
  if (!order.length) return null;
  const docs = new Set(order.map((id) => kb?.byId.get(id)?.doc.doc ?? id)).size;
  return (
    <div className="mt-3.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "group/src inline-flex h-8 items-center gap-2 rounded-full border bg-background pr-2.5 pl-1.5 text-[13px] text-muted-foreground transition-colors hover:border-input hover:text-foreground dark:bg-transparent",
          open && "border-input text-foreground",
        )}
      >
        <span className="flex">
          {order.slice(0, 4).map((id, i) => (
            <span
              key={id}
              className="tnum -ml-1 flex size-5 items-center justify-center rounded-[6px] bg-primary text-[10.5px] font-semibold text-white ring-2 ring-background first:ml-0"
            >
              {i + 1}
            </span>
          ))}
        </span>
        <span className="tnum">
          {order.length} {plural(order.length)}
          <span className="text-muted-foreground">
            {" "}
            · {docs} {docs === 1 ? "документ" : docs < 5 ? "документа" : "документов"}
          </span>
        </span>
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ol
          className="msg-in mt-2 divide-y overflow-hidden rounded-xl border bg-background dark:bg-card"
          aria-label="Источники ответа"
        >
          {order.map((id, i) => {
            const entry = kb?.byId.get(id);
            const section = entry ? entry.chunk.path.split(" > ").pop() || entry.doc.title : `#${id}`;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => {
                    const entry = kb?.byId.get(id);
                    onOpen(
                      id,
                      entry && answer ? bestCitationLine(answer.citations, id, entry.chunk.text)?.line : undefined,
                    );
                  }}
                  className="group/row flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted"
                >
                  <SourceNumber n={i + 1} className="size-5 rounded-[6px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{section}</span>
                    {entry && <span className="block truncate text-xs text-muted-foreground">{entry.doc.title}</span>}
                  </span>
                  <ArrowUpRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100" />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
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
  onOpenChunk: OpenChunk;
  showCitations?: boolean;
  className?: string;
}) {
  const handle = useMemo(() => createHoverCardHandle<CitePayload>(), []);
  if (!answer?.citations?.length || !showCitations) {
    return (
      <p className={cn("whitespace-pre-wrap", className)}>
        <TermText pieces={markTerms(safeAnswerText(text))} kb={kb} />
      </p>
    );
  }
  const order = citationOrder(answer);
  // Подсказки к терминам (T16): каждый термин подчёркивается один раз на весь ответ.
  const seen = new Set<string>();
  const parts = answer.citations.map((c) => markTerms(safeAnswerText(c.sentence), seen));
  return (
    <>
      <p className={className}>
        {answer.citations.map((c, i) => (
          <span key={i}>
            <TermText pieces={parts[i]} kb={kb} />
            {!c.question && c.support.length > 0 && (
              <span className="whitespace-nowrap">
                {c.support.slice(0, 2).map((s) => (
                  <SourceChip
                    key={s.id}
                    id={s.id}
                    n={order.indexOf(s.id) + 1}
                    sentence={safeAnswerText(c.sentence)}
                    kb={kb}
                    onOpen={onOpenChunk}
                    handle={handle}
                  />
                ))}
              </span>
            )}
            {i < answer.citations.length - 1 ? " " : ""}
          </span>
        ))}
      </p>
      {/* Одна карточка на весь ответ: при переходе между соседними чипами она не пересоздаётся и не моргает */}
      <HoverCard handle={handle}>
        {({ payload }) =>
          payload ? (
            <HoverCardContent side="top" className="w-80 p-4">
              <SourcePreview id={payload.id} sentence={payload.sentence} kb={kb} onOpen={onOpenChunk} />
            </HoverCardContent>
          ) : null
        }
      </HoverCard>
    </>
  );
}
