"use client";

import { ChevronRight, FileText, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DocView } from "@/components/kb/doc-view";
import { Input } from "@/components/ui/input";
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

  const chunkId = params.get("chunk") ?? undefined;
  const docParam = params.get("doc");
  const entry = chunkId ? kb?.byId.get(chunkId) : undefined;
  const doc = entry?.doc ?? (docParam ? kb?.byDoc.get(docParam) : undefined) ?? kb?.data.docs[0];

  const go = (next: { doc?: string; chunk?: string }) => {
    const sp = new URLSearchParams();
    if (next.chunk) sp.set("chunk", next.chunk);
    else if (next.doc) sp.set("doc", next.doc);
    router.replace(`${pathname}?${sp}`, { scroll: false });
  };

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!kb || query.length < 2) return [];
    const out = [];
    for (const d of kb.data.docs)
      for (const c of d.chunks)
        if (`${c.path}\n${c.text}`.toLowerCase().includes(query)) out.push({ d, c });
    return out.slice(0, 60);
  }, [kb, q]);

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

  if (error) return <div className="p-8 text-sm text-destructive">{error}</div>;

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-80 shrink-0 flex-col border-r bg-sidebar">
        <div className="space-y-2 border-b p-3">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск по базе знаний"
              className="h-8 pr-8 pl-8 text-sm"
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground"
                aria-label="Очистить"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          {kb && (
            <div className="text-[11px] text-muted-foreground">
              {kb.data.docs.length} документов · {kb.byId.size} разделов · версия {kb.data.fingerprint.slice(0, 8)}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {!kb && Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="mx-2 my-2 h-5" />)}
          {q.trim().length >= 2 ? (
            <div className="space-y-1">
              <div className="px-2 py-1 text-[11px] text-muted-foreground">Найдено разделов: {results.length}</div>
              {results.map(({ d, c }) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => go({ chunk: c.id })}
                  className={cn(
                    "w-full rounded-lg px-2 py-1.5 text-left hover:bg-sidebar-accent",
                    c.id === chunkId && "bg-sidebar-accent",
                  )}
                >
                  <div className="text-[11px] text-muted-foreground">{d.title}</div>
                  <div className="text-sm leading-snug">{c.path}</div>
                </button>
              ))}
            </div>
          ) : (
            groups.map(([group, docs]) => (
              <div key={group} className="mb-3">
                <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {GROUPS[group] ?? group}
                </div>
                {docs.map((d) => {
                  const active = d.doc === doc?.doc;
                  const expanded = open.has(d.doc) || active;
                  return (
                    <div key={d.doc}>
                      <div
                        className={cn(
                          "flex items-center rounded-lg text-sm hover:bg-sidebar-accent",
                          active && "bg-sidebar-accent font-medium",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => toggle(d.doc)}
                          className="p-1.5 text-muted-foreground"
                          aria-label="Разделы"
                        >
                          <ChevronRight className={cn("size-3.5 transition", expanded && "rotate-90")} />
                        </button>
                        <button
                          type="button"
                          onClick={() => go({ doc: d.doc })}
                          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left"
                        >
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{d.title}</span>
                        </button>
                      </div>
                      {expanded && (
                        <div className="mb-1 ml-5 border-l pl-2">
                          {d.chunks
                            .filter((c) => c.path !== d.title)
                            .map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => go({ chunk: c.id })}
                                className={cn(
                                  "block w-full truncate rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                                  c.id === chunkId && "bg-brand-soft text-brand",
                                )}
                                title={c.path}
                              >
                                {c.path.split(" > ").pop()}
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-8">
        {doc && kb ? (
          <DocView doc={doc} kb={kb} focusId={chunkId} onDoc={(d) => go({ doc: d })} query={q.trim().length >= 2 ? q : undefined} />
        ) : (
          <div className="mx-auto max-w-3xl space-y-3">
            <Skeleton className="h-8 w-80" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        )}
      </main>
    </div>
  );
}
