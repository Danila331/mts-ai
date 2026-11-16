"use client";

import Link from "next/link";
import { KbIndex, kbHref } from "@/hooks/use-kb";
import type { HistoryTurn } from "@/lib/manager";
import { cn } from "@/lib/utils";

/** Блок карточки с заголовком — общий для карточки заявки и карточки диалога. */
export function Block({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("border-t px-5 py-4", className)}>
      <h3 className="mb-2 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function Row({
  label,
  value,
  empty = "—",
  children,
}: {
  label: string;
  value: string;
  empty?: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words", !value && "text-muted-foreground")}>
        {value || empty}
        {children}
      </dd>
    </>
  );
}

/** Переписка по порядку: клиент справа, консультант слева, под ответом — источники из базы знаний. */
export function TurnList({ turns, kb }: { turns: HistoryTurn[]; kb: KbIndex | null }) {
  return (
    <ol className="space-y-3">
      {turns.map((t, i) => (
        <Turn key={i} turn={t} kb={kb} />
      ))}
    </ol>
  );
}

function Turn({ turn, kb }: { turn: HistoryTurn; kb: KbIndex | null }) {
  const user = turn.role === "user";
  return (
    <li className={cn("flex", user && "justify-end")}>
      <div className={cn("max-w-[92%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed", user ? "bg-muted" : "border")}>
        <p className="whitespace-pre-wrap">{turn.content}</p>
        {turn.fallback && (
          <p className="mt-1.5 text-[12px] font-medium text-tone-warning">Запасной ответ — бот не нашёл ответа в базе</p>
        )}
        {turn.sources && turn.sources.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
            <span className="text-muted-foreground">Источники:</span>
            {turn.sources.map((id, n) => {
              const hit = kb?.byId.get(id);
              return (
                <Link
                  key={id}
                  href={kbHref(id)}
                  target="_blank"
                  title={hit ? `${hit.doc.title} — ${hit.chunk.path}` : "Раздел базы знаний"}
                  className="inline-flex h-[17px] items-center rounded-md bg-primary px-1.5 text-[10.5px] font-semibold text-white"
                >
                  {n + 1}
                </Link>
              );
            })}
          </p>
        )}
      </div>
    </li>
  );
}
