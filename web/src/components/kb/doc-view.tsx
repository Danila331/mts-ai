"use client";

import { Check, Clock3, FileCode2, FolderOpen, ListOrdered } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { GROUPS, type KbIndex } from "@/hooks/use-kb";
import type { KbDoc } from "@/lib/types";
import { cn } from "@/lib/utils";
import { flash, scrollToElement } from "@/lib/smooth-scroll";
import { ChunkText } from "./chunk-text";

export function Tag({ tone, children }: { tone: "neutral" | "warning" | "info"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "warning" && "bg-tone-warning text-white",
        tone === "info" && "bg-tone-info text-white",
      )}
    >
      {children}
    </span>
  );
}

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/** Номер документа из имени файла: 23-solar.md → 23. */
export function docNumber(doc: string) {
  return doc.split("/").pop()?.match(/^(\d{2})/)?.[1] ?? "··";
}

/** Путь раздела без названия документа: «Солнечные станции под ключ > Сроки» → ["Сроки"]. */
function sectionParts(path: string, title: string) {
  const parts = path.split(" > ");
  return parts[0] === title && parts.length > 1 ? parts.slice(1) : parts;
}

/**
 * Документ базы, нарезанный теми же разделами, что видит модель. У каждого раздела якорь #c-<id>,
 * focusId прокручивает к разделу и подсвечивает его. toc — оглавление справа на широких экранах.
 */
export function DocView({
  doc,
  kb,
  focusId,
  focusLine,
  marked,
  onDoc,
  query,
  scrollRoot,
  toc,
}: {
  doc: KbDoc;
  kb: KbIndex | null;
  focusId?: string;
  /** Номер строки раздела focusId (lib/line-match.ts): к ней прокручиваем и её подсвечиваем. */
  focusLine?: number;
  marked?: Set<string>;
  onDoc?: (doc: string) => void;
  query?: string;
  scrollRoot?: HTMLElement | null;
  toc?: boolean;
}) {
  const refs = useRef(new Map<string, HTMLElement>());
  const [copied, setCopied] = useState("");
  const [current, setCurrent] = useState<string>("");

  useEffect(() => {
    if (!focusId) return;
    const el = refs.current.get(focusId);
    if (!el) return;
    const t = setTimeout(() => {
            // Строка, на которую опирается ответ; нет совпадения — подсвечиваем раздел целиком, как раньше.
      const row = focusLine == null ? null : el.querySelector<HTMLElement>(`[data-line="${focusLine}"]`);
      if (scrollRoot) {
        if (row) scrollToElement(scrollRoot, row, { align: "center", duration: 450 });
        else scrollToElement(scrollRoot, el, { duration: 420 });
      } else (row ?? el).scrollIntoView({ block: row ? "center" : "start", behavior: "smooth" });
      flash(el, "kb-flash");
      if (row) flash(row, "kb-line-flash");
    }, 60);
    return () => clearTimeout(t);
  }, [focusId, focusLine, doc.doc, scrollRoot]);

  // Оглавление: подсвечиваем раздел, который сейчас вверху экрана.
  useEffect(() => {
    if (!toc || !scrollRoot) return;
    const onScroll = () => {
      const top = scrollRoot.getBoundingClientRect().top + 120;
      let id = doc.chunks[0]?.id ?? "";
      for (const c of doc.chunks) {
        const el = refs.current.get(c.id);
        if (el && el.getBoundingClientRect().top <= top) id = c.id;
      }
      setCurrent(id);
    };
    onScroll();
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollRoot.removeEventListener("scroll", onScroll);
  }, [toc, scrollRoot, doc]);

  const copyLink = (id: string) => {
    const url = `${window.location.origin}/kb?chunk=${id}`;
    void navigator.clipboard.writeText(url);
    setCopied(id);
    toast.success("Ссылка на раздел скопирована");
    setTimeout(() => setCopied(""), 1500);
  };

  const allReference = doc.chunks.every((c) => c.is_reference);
  const sections = doc.chunks.filter((c) => c.path !== doc.title);
  const showToc = toc && sections.length > 2;
  const num = docNumber(doc.doc);
  const siblings = kb?.data.docs.filter((d) => d.group === doc.group) ?? [];
  const position = siblings.length > 1 ? { index: siblings.findIndex((d) => d.doc === doc.doc) + 1, total: siblings.length } : null;
  const words = doc.chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
  const minutes = Math.max(1, Math.round(words / 180));
  // Номер раздела внутри документа: 23.4 — как главы, совпадает с оглавлением справа.
  const sectionNo = new Map(sections.map((c, i) => [c.id, `${num}.${i + 1}`]));

  return (
    <div className={cn("mx-auto flex gap-14", showToc ? "max-w-[1000px]" : "max-w-[720px]")}>
      <article className="min-w-0 max-w-[720px] flex-1">
        <header className="mb-8">
          <div className="flex items-start gap-4 sm:gap-6">
            <span
              aria-label={`Документ ${num}`}
              className="tnum shrink-0 font-mono text-[44px] leading-[0.95] font-medium tracking-[-0.06em] text-brand-text select-none sm:text-[56px]"
            >
              {num}
            </span>
            <h1 className="min-w-0 pt-0.5 text-[28px] leading-[1.12] font-semibold tracking-[-0.025em] text-balance sm:pt-1 sm:text-[32px]">
              {doc.title}
            </h1>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-y py-3 text-[13px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <FolderOpen className="size-3.5" />
              <span className="text-foreground/85">{GROUPS[doc.group] ?? doc.group}</span>
              {position && (
                <span className="tnum">
                  · {position.index} из {position.total}
                </span>
              )}
            </span>
            <span className="tnum flex items-center gap-1.5">
              <ListOrdered className="size-3.5" />
              {doc.chunks.length} {plural(doc.chunks.length, "раздел", "раздела", "разделов")}
            </span>
            <span className="tnum flex items-center gap-1.5">
              <Clock3 className="size-3.5" />≈ {minutes} мин чтения
            </span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(doc.doc);
                toast.success("Путь к файлу скопирован");
              }}
              title="Скопировать путь к файлу"
              className="flex min-w-0 items-center gap-1.5 rounded-md transition-colors hover:text-foreground sm:ml-auto"
            >
              <FileCode2 className="size-3.5 shrink-0" />
              <code className="truncate font-mono text-xs">{doc.doc}</code>
            </button>
          </div>
        </header>

        <div className="space-y-1">
          {doc.chunks.map((c) => {
            const isIntro = c.path === doc.title;
            const parts = sectionParts(c.path, doc.title);
            const focused = focusId === c.id;
            const inContext = !!marked?.has(c.id);
            return (
              <section
                key={c.id}
                id={`c-${c.id}`}
                ref={(el) => {
                  if (el) refs.current.set(c.id, el);
                }}
                className={cn(
                  "group/sec relative -mx-5 scroll-mt-6 rounded-2xl px-5 py-5 transition-colors",
                  focused && "bg-surface ring-1 ring-primary",
                )}
              >
                {!isIntro && (
                  <div className="mb-3 flex items-start gap-3">
                    <h2 className="relative min-w-0 flex-1 text-[18px] leading-snug font-semibold tracking-[-0.01em]">
                      <button
                        type="button"
                        onClick={() => copyLink(c.id)}
                        className={cn(
                          "tnum font-mono text-[12px] font-medium text-muted-foreground transition-colors hover:text-brand-text",
                          toc
                            ? "absolute top-[3px] -left-[4.25rem] hidden w-12 justify-end xl:flex"
                            : "mr-2.5 inline-flex -translate-y-px align-middle",
                        )}
                        aria-label={`Скопировать ссылку на раздел ${sectionNo.get(c.id)}`}
                        title={`Скопировать ссылку · #${c.id}`}
                      >
                        {copied === c.id ? <Check className="size-3.5 text-success" /> : sectionNo.get(c.id)}
                      </button>
                      {toc && (
                        <span className="tnum mr-2.5 inline-flex -translate-y-px align-middle font-mono text-[12px] font-medium text-muted-foreground xl:hidden">
                          {sectionNo.get(c.id)}
                        </span>
                      )}
                      {parts.map((p, i) => (
                        <span key={i} className={i < parts.length - 1 ? "font-normal text-muted-foreground" : undefined}>
                          {p}
                          {i < parts.length - 1 && <span className="mx-1.5 text-muted-foreground">/</span>}
                        </span>
                      ))}
                    </h2>
                    <div className="flex shrink-0 items-center gap-1.5 pt-1">
                      {c.is_reference && !allReference && <Tag tone="neutral">справочник</Tag>}
                      {c.is_guard && <Tag tone="warning">ограничения</Tag>}
                      {inContext && <Tag tone="info">в контексте</Tag>}
                    </div>
                  </div>
                )}
                {isIntro && (c.is_guard || inContext) && (
                  <div className="mb-3 flex gap-1.5">
                    {c.is_guard && <Tag tone="warning">ограничения</Tag>}
                    {inContext && <Tag tone="info">в контексте</Tag>}
                  </div>
                )}
                <ChunkText
                  text={c.text}
                  kb={kb}
                  onDoc={onDoc}
                  highlight={query}
                  focusLine={focused ? focusLine : undefined}
                  className={cn(
                    "text-pretty",
                    isIntro ? "text-[16px] leading-[1.7] text-foreground" : "text-[15px] leading-[1.7] text-foreground/90",
                  )}
                />
              </section>
            );
          })}
        </div>
      </article>

      {showToc && (
        <nav aria-label="Оглавление документа" className="sticky top-2 hidden w-[200px] shrink-0 self-start pt-1 xl:block">
          <div className="mb-3 text-[13px] font-medium">На странице</div>
          <ol className="space-y-px border-l">
            {sections.map((c) => {
              const active = current === c.id || (!current && focusId === c.id);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      const el = refs.current.get(c.id);
                      if (el && scrollRoot) scrollToElement(scrollRoot, el, { duration: 420 });
                      else el?.scrollIntoView({ block: "start", behavior: "smooth" });
                    }}
                    className={cn(
                      "-ml-px flex w-full gap-2 border-l py-1 pr-1 pl-3 text-left text-[12.5px] leading-snug transition-colors",
                      active
                        ? "border-brand font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span className="tnum w-[34px] shrink-0 pt-px font-mono text-[11px] text-muted-foreground">{sectionNo.get(c.id)}</span>
                    <span className="min-w-0">{sectionParts(c.path, doc.title).pop()}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
    </div>
  );
}
