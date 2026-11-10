"use client";

import { useEffect, useMemo, useState } from "react";
import { getKb } from "@/lib/api";
import type { KbChunk, KbData, KbDoc } from "@/lib/types";

export interface KbIndex {
  data: KbData;
  byId: Map<string, { chunk: KbChunk; doc: KbDoc }>;
  byDoc: Map<string, KbDoc>;
  /** Ссылки в тексте базы указывают на имя файла (23-solar.md) — сопоставляем с полным путём. */
  byFile: Map<string, KbDoc>;
}

export function useKb() {
  const [data, setData] = useState<KbData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    getKb()
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  const index = useMemo<KbIndex | null>(() => {
    if (!data) return null;
    const byId = new Map<string, { chunk: KbChunk; doc: KbDoc }>();
    const byDoc = new Map<string, KbDoc>();
    const byFile = new Map<string, KbDoc>();
    for (const doc of data.docs) {
      byDoc.set(doc.doc, doc);
      byFile.set(doc.doc.split("/").pop()!, doc);
      for (const chunk of doc.chunks) byId.set(chunk.id, { chunk, doc });
    }
    return { data, byId, byDoc, byFile };
  }, [data]);

  return { kb: index, error };
}

export const GROUPS: Record<string, string> = {
  "00-reference": "Справочник",
  "10-energy": "Энергорынок",
  "20-products": "Продукты",
};

export function kbHref(chunkId: string) {
  return `/kb?chunk=${chunkId}`;
}
