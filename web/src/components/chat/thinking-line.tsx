"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BrandGlyph } from "@/components/brand";
import type { Message } from "@/lib/types";
import { cn } from "@/lib/utils";

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

type Phase = "search" | "read" | "write";

/**
 * Фразы идут по настоящим этапам потока (stage: retrieval → generation), а внутри этапа сменяются,
 * чтобы долгое ожидание не выглядело зависанием. Ничего не обещаем сверх того, что делает ядро:
 * поиск по базе, отбор разделов, ответ модели и проверка чисел по базе.
 */
function phrases(phase: Phase, sections: number, docs: number): string[] {
  if (phase === "search") return ["Ищу в базе знаний", "Подбираю разделы под вопрос", "Сравниваю формулировки"];
  if (phase === "read")
    return [
      `Читаю ${sections} ${plural(sections, "раздел", "раздела", "разделов")} из ${docs} ${plural(docs, "документа", "документов", "документов")}`,
      "Отбираю главное для ответа",
    ];
  return ["Формулирую ответ", "Сверяю цифры с базой знаний", "Проверяю, что каждый факт есть в базе"];
}

const STEP_MS = 2800;
const OUT_MS = 200;

/**
 * Строка «консультант думает» — как у Claude и ChatGPT: значок, переливающаяся фраза и секундомер.
 * Смена фразы — по очереди, без наложения: старая гаснет (200 мс), затем новая проявляется;
 * ширина строки подстраивается плавно, поэтому секундомер не прыгает.
 */
export function ThinkingLine({ message, compact }: { message: Message; compact?: boolean }) {
  const retrieval = message.retrieval;
  const { sections, docTitles } = useMemo(() => {
    const hits = retrieval?.hits.filter((h) => h.in_context) ?? [];
    return { sections: hits.length, docTitles: [...new Set(hits.map((h) => h.title).filter(Boolean))] };
  }, [retrieval]);
  const phase: Phase = message.stage === "generation" ? "write" : sections ? "read" : "search";
  const list = phrases(phase, sections, docTitles.length || 1);

  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- новый этап начинается со своей первой фразы
    setTick(0);
    const t = setInterval(() => setTick((v) => v + 1), STEP_MS);
    return () => clearInterval(t);
  }, [phase]);

  // На последней фразе этапа останавливаемся: дальше её сменит следующий этап, а не круг по новой.
  const text = list[Math.min(tick, list.length - 1)];

  // Сначала гасим текущую фразу, и только потом показываем новую — две фразы никогда не видны разом.
  const [shown, setShown] = useState(text);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (text === shown) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- последовательная смена фразы
    setLeaving(true);
    const t = setTimeout(() => {
      setShown(text);
      setLeaving(false);
    }, OUT_MS);
    return () => clearTimeout(t);
  }, [text, shown]);

  // Ширина строки едет к ширине новой фразы, а не прыгает.
  const measure = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (measure.current) setWidth(Math.ceil(measure.current.getBoundingClientRect().width));
  }, [shown]);

  const seconds = Math.max(0, Math.floor((now - message.createdAt) / 1000));
  const size = compact ? "text-[14px]" : "text-[15px]";

  return (
    <div className="flex flex-col gap-1">
      {/* Без живой области: ответ озвучивается целиком по завершении (T43), а не каждой сменой фразы. */}
      <span className="sr-only">Консультант готовит ответ</span>
      <div className="flex min-h-7 min-w-0 items-center gap-2">
        <BrandGlyph live className={compact ? "size-[18px]" : "size-5"} />
        <span
          className={cn("relative grid h-6 max-w-full items-center overflow-hidden transition-[width] duration-500 ease-out", size)}
          style={{ width }}
          aria-hidden
        >
          <span key={shown} className={cn("col-start-1 row-start-1 whitespace-nowrap", leaving ? "think-out" : "think-in")}>
            <span className="shimmer-text">{shown}</span>
          </span>
        </span>
        {/* скрытый замер ширины текущей фразы */}
        <span ref={measure} className={cn("pointer-events-none invisible absolute whitespace-nowrap", size)} aria-hidden>
          {shown}
        </span>
        {seconds >= 2 && (
          <span className="think-fade tnum shrink-0 font-mono text-[11px] text-muted-foreground" aria-hidden>
            {seconds} с
          </span>
        )}
      </div>
      {!compact && phase !== "search" && docTitles.length > 0 && (
        <p className="think-fade truncate pl-7 text-[12px] text-muted-foreground">
          {docTitles.slice(0, 3).join(" · ")}
          {docTitles.length > 3 && ` и ещё ${docTitles.length - 3}`}
        </p>
      )}
    </div>
  );
}
