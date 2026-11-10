"use client";

import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { type KbIndex, kbHref } from "@/hooks/use-kb";
import { DocView } from "./doc-view";

/** Раздел базы поверх стенда: документ целиком, прокручен к разделу. Чат и отладка остаются на месте. */
export function ChunkSheet({
  kb,
  chunkId,
  onClose,
  marked,
}: {
  kb: KbIndex | null;
  chunkId: string | null;
  onClose: () => void;
  marked?: Set<string>;
}) {
  const [docOverride, setDocOverride] = useState<{ for: string | null; doc: string } | null>(null);
  const entry = chunkId ? kb?.byId.get(chunkId) : undefined;
  const doc = (docOverride?.for === chunkId && docOverride ? kb?.byDoc.get(docOverride.doc) : undefined) ?? entry?.doc;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);

  return (
    <Sheet open={!!chunkId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 data-[side=right]:w-[min(720px,100vw)] data-[side=right]:sm:max-w-none"
      >
        <SheetHeader className="h-14 shrink-0 flex-row items-center gap-3 border-b px-5 py-0 pr-14">
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-[15px] leading-tight">База знаний</SheetTitle>
            <SheetDescription className="text-xs">Тот же раздел, что видела модель</SheetDescription>
          </div>
          {chunkId && (
            <a
              href={kbHref(chunkId)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              В новой вкладке <ArrowUpRight className="size-3.5" />
            </a>
          )}
        </SheetHeader>
        <div ref={setRoot} className="min-h-0 flex-1 overflow-y-auto px-6 pt-6 pb-16 sm:px-10">
          {doc && kb ? (
            <DocView
              doc={doc}
              kb={kb}
              focusId={doc === entry?.doc ? chunkId ?? undefined : undefined}
              marked={marked}
              onDoc={(d) => setDocOverride({ for: chunkId, doc: d })}
              scrollRoot={root}
            />
          ) : (
            <div className="text-[14px] text-muted-foreground">Раздел не найден в базе ({chunkId})</div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
