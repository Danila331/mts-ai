"use client";

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
      <SheetContent side="right" className="w-full gap-0 p-0 data-[side=right]:w-[min(720px,92vw)] data-[side=right]:sm:max-w-none">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="text-sm">База знаний</SheetTitle>
          <SheetDescription className="flex items-center gap-2 text-xs">
            Тот же раздел, что видела модель
            {chunkId && (
              <Button
                variant="link"
                size="xs"
                className="h-auto p-0 text-brand"
                nativeButton={false}
                render={<a href={kbHref(chunkId)} target="_blank" rel="noreferrer" />}
              >
                открыть во вкладке <ExternalLink />
              </Button>
            )}
          </SheetDescription>
        </SheetHeader>
        <div ref={setRoot} className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
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
            <div className="text-sm text-muted-foreground">Раздел не найден в базе ({chunkId})</div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
