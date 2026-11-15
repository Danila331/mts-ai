"use client";

import { BookOpen, ChevronRight, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell, PageBar, SidebarLabel } from "@/components/app-shell";
import { DocView, docNumber } from "@/components/kb/doc-view";
import { Skeleton } from "@/components/ui/skeleton";
import { GROUPS, useKb } from "@/hooks/use-kb";
import type { KbDoc } from "@/lib/types";
import { cn } from "@/lib/utils";

export function KbBrowser() {
  const { kb, error } = useKb();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  const chunkId = params.get("chunk") ?? undefined;
  const docParam = params.get("doc");
  const entry = chunkId ? kb?.byId.get(chunkId) : undefined;
  const doc = entry?.doc ?? (docParam ? kb?.byDoc.get(docParam) : undefined) ?? kb?.data.docs[0];
  const query = q.trim().length >= 2 ? q.trim() : "";

  const go = (next: { doc?: string; chunk?: string }) => {
    const sp = new URLSearchParams();
    if (next.chunk) sp.set("chunk", next.chunk);
    else if (next.doc) sp.set("doc", next.doc);
    router.replace(`${pathname}?${sp}`, { scroll: false });
  };

  const results = useMemo(() => {
    const needle = query.toLowerCase();
    if (!kb || !needle) return [];
    const out = [];
    for (const d of kb.data.docs)
      for (const c of d.chunks) if (`${c.path}\n${c.text}`.toLowerCase().includes(needle)) out.push({ d, c });
    return out.slice(0, 60);
  }, [kb, query]);

  const groups = useMemo(() => {
    const map = new Map<string, KbDoc[]>();
    for (const d of kb?.data.docs ?? []) map.set(d.group, [...(map.get(d.group) ?? []), d]);
    return [...map.entries()];
  }, [kb]);

  const toggle = (d: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });

  const tree = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-2.5">
        <label className="flex h-9 items-center gap-2 rounded-lg border border-sidebar-border bg-background px-2.5 text-muted-foreground transition-colors focus-within:border-ring/70 dark:bg-sidebar-accent">
          <Search className="size-4 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по базе знаний"
            aria-label="Поиск по базе знаний"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          {q ? (
            <button type="button" onClick={() => setQ("")} aria-label="Очистить поиск" className="hover:text-foreground">
              <X className="size-3.5" />
            </button>
          ) : (
            kb && <span className="tnum font-mono text-[11px] text-muted-foreground">{kb.byId.size}</span>
          )}
        </label>
      </div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {!kb && !error && (
          <div className="space-y-2.5 px-2.5 pt-4">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-4" style={{ width: `${55 + ((i * 17) % 40)}%` }} />
            ))}
          </div>
        )}
        {query ? (
          <div>
            <SidebarLabel>
              {results.length ? `Нашлось разделов: ${results.length}` : "Ничего не нашлось — попробуйте другое слово"}
            </SidebarLabel>
            {results.map(({ d, c }) => (
              <button
                key={c.id}
                type="button"
                onClick={() => go({ chunk: c.id })}
                className={cn(
                  "flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-sidebar-accent",
                  c.id === chunkId && "bg-sidebar-accent",
                )}
              >
                <span className="tnum mt-px w-5 shrink-0 font-mono text-[11px] text-muted-foreground">{docNumber(d.doc)}</span>
                <span className="min-w-0">
                  <span className="block text-[13.5px] leading-snug">{c.path.split(" > ").pop()}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">{d.title}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          groups.map(([group, docs]) => (
            <section key={group} aria-label={GROUPS[group] ?? group} className="mt-3 first:mt-1">
              <div className="flex items-baseline justify-between px-2.5 pt-2 pb-1.5">
                <span className="text-xs font-medium text-muted-foreground">{GROUPS[group] ?? group}</span>
                <span className="tnum font-mono text-[11px] text-muted-foreground">{docs.length}</span>
              </div>
              {docs.map((d) => {
                const active = d.doc === doc?.doc;
                const expanded = open.has(d.doc) || active;
                const sections = d.chunks.filter((c) => c.path !== d.title);
                return (
                  <div key={d.doc}>
                    <div
                      className={cn(
                        "group/doc flex h-9 items-center rounded-lg transition-colors hover:bg-sidebar-accent",
                        active && "bg-sidebar-accent",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => go({ doc: d.doc })}
                        aria-current={active ? "page" : undefined}
                        title={d.title}
                        className="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-2.5 text-left"
                      >
                        <span
                          className={cn(
                            "tnum w-5 shrink-0 font-mono text-[11px]",
                            active ? "font-medium text-brand-text" : "text-muted-foreground",
                          )}
                        >
                          {docNumber(d.doc)}
                        </span>
                        <span
                          className={cn(
                            "truncate text-[14px]",
                            active ? "font-medium text-foreground" : "text-sidebar-foreground/85",
                          )}
                        >
                          {d.title}
                        </span>
                      </button>
                      {sections.length > 0 && (
                        <button
                          type="button"
                          onClick={() => toggle(d.doc)}
                          className={cn(
                            "mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:text-foreground group-hover/doc:opacity-100 focus-visible:opacity-100",
                            expanded && "opacity-100",
                          )}
                          aria-label={expanded ? "Свернуть разделы" : "Показать разделы"}
                          aria-expanded={expanded}
                        >
                          <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
                        </button>
                      )}
                    </div>
                    {expanded && sections.length > 0 && (
                      <ol className="relative mt-0.5 mb-2 ml-[19px] border-l border-sidebar-border">
                        {sections.map((c) => {
                          const on = c.id === chunkId;
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                onClick={() => go({ chunk: c.id })}
                                title={c.path}
                                className={cn(
                                  "-ml-px block w-full truncate border-l py-[5px] pr-2 pl-3.5 text-left text-[13px] transition-colors",
                                  on
                                    ? "border-brand font-medium text-foreground"
                                    : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
                                )}
                              >
                                {c.path.split(" > ").pop()}
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                );
              })}
            </section>
          ))
        )}
      </div>
      {kb && (
        <p className="tnum shrink-0 truncate px-4.5 pt-1 pb-2 text-[11.5px] text-muted-foreground">
          {kb.data.docs.length} док. · {kb.byId.size} разд. · версия{" "}
          <span className="font-mono">{kb.data.fingerprint.slice(0, 8)}</span>
        </p>
      )}
    </div>
  );

  return (
    <AppShell sidebar={tree} wide>
      <PageBar
        icon={BookOpen}
        title={
          doc ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-medium text-muted-foreground">{GROUPS[doc.group] ?? doc.group}</span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{doc.title}</span>
            </span>
          ) : (
            "База знаний"
          )
        }
      />
      <div ref={setScroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-6 pt-4 pb-28 sm:px-10 lg:px-14">
          {error ? (
            <div className="mx-auto max-w-[720px] rounded-xl bg-tone-danger px-4 py-3 text-[14px] text-white">
              {error}. Запустите API: docker compose up
            </div>
          ) : doc && kb ? (
            <DocView
              doc={doc}
              kb={kb}
              focusId={chunkId}
              onDoc={(d) => go({ doc: d })}
              query={query || undefined}
              scrollRoot={scroller}
              toc
            />
          ) : (
            <div className="mx-auto max-w-[720px] space-y-4">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-9 w-96 max-w-full" />
              <Skeleton className="mt-8 h-24" />
              <Skeleton className="h-24" />
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
