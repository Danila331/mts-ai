"use client";

import { Check, Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { GROUPS, type KbIndex } from "@/hooks/use-kb";
import type { KbDoc } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ChunkText } from "./chunk-text";

/**
 * Документ базы, нарезанный теми же разделами, что видит модель. У каждого раздела якорь #c-<id>,
 * focusId прокручивает к разделу и подсвечивает его.
 */
export function DocView({
  doc,
  kb,
  focusId,
  marked,
  onDoc,
  query,
  scrollRoot,
}: {
  doc: KbDoc;
  kb: KbIndex | null;
  focusId?: string;
  marked?: Set<string>;
  onDoc?: (doc: string) => void;
  query?: string;
  scrollRoot?: HTMLElement | null;
}) {
  const refs = useRef(new Map<string, HTMLElement>());
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (!focusId) return;
    const el = refs.current.get(focusId);
    if (!el) return;
    const t = setTimeout(() => {
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      el.classList.remove("kb-flash");
      void el.offsetWidth; // перезапуск анимации подсветки
      el.classList.add("kb-flash");
    }, 60);
    return () => clearTimeout(t);
  }, [focusId, doc.doc, scrollRoot]);

  const copyLink = (id: string) => {
    const url = `${window.location.origin}/kb?chunk=${id}`;
    void navigator.clipboard.writeText(url);
    setCopied(id);
    toast.success("Ссылка на раздел скопирована");
    setTimeout(() => setCopied(""), 1500);
  };

  return (
    <article className="mx-auto max-w-3xl pb-24">
      <header className="mb-6 space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{GROUPS[doc.group] ?? doc.group}</span>
          <span>·</span>
          <code className="font-mono">{doc.doc}</code>
          <span>·</span>
          <span>{doc.chunks.length} разд.</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{doc.title}</h1>
      </header>
      <div className="space-y-3">
        {doc.chunks.map((c) => {
          const parts = c.path.split(" > ");
          const isTitle = c.path === doc.title;
          return (
            <section
              key={c.id}
              id={`c-${c.id}`}
              ref={(el) => {
                if (el) refs.current.set(c.id, el);
              }}
              className={cn(
                "group scroll-mt-4 rounded-xl border bg-card p-4 transition-colors",
                focusId === c.id && "border-brand/60 ring-2 ring-brand/20",
                marked?.has(c.id) && focusId !== c.id && "border-sky-300 dark:border-sky-700",
              )}
            >
              <div className="mb-2 flex items-start gap-2">
                <h2 className="flex-1 text-[15px] font-semibold leading-snug">
                  {isTitle ? (
                    <span className="text-muted-foreground">Вступление</span>
                  ) : (
                    parts.map((p, i) => (
                      <span key={i} className={i < parts.length - 1 ? "text-muted-foreground" : undefined}>
                        {p}
                        {i < parts.length - 1 && <span className="mx-1 text-muted-foreground/60">›</span>}
                      </span>
                    ))
                  )}
                </h2>
                <div className="flex shrink-0 items-center gap-1">
                  {c.is_reference && <Badge variant="secondary">справочник</Badge>}
                  {c.is_guard && (
                    <Badge variant="outline" className="border-amber-300 text-amber-700 dark:text-amber-400">
                      ограничения
                    </Badge>
                  )}
                  {marked?.has(c.id) && (
                    <Badge variant="outline" className="border-sky-300 text-sky-700 dark:text-sky-400">
                      в контексте
                    </Badge>
                  )}
                  <button
                    type="button"
                    onClick={() => copyLink(c.id)}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    title="Скопировать ссылку на раздел"
                  >
                    {copied === c.id ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
                  </button>
                </div>
              </div>
              <ChunkText text={c.text} kb={kb} onDoc={onDoc} highlight={query} />
              <div className="mt-2 font-mono text-[10px] text-muted-foreground/70">#{c.id}</div>
            </section>
          );
        })}
      </div>
    </article>
  );
}
