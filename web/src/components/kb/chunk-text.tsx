import { Fragment, type ReactNode } from "react";
import type { KbIndex } from "@/hooks/use-kb";
import { cn } from "@/lib/utils";

const PATH = String.raw`(?:\.\./)?(?:[0-9]{2}-[\w-]+/)?([0-9]{2}-[\w-]+\.md)`;
// [текст](23-solar.md#раздел) или просто `23-solar.md`
const FILE = new RegExp(String.raw`\[([^\]]+)\]\(${PATH}(?:#[^)]*)?\)|` + "`?" + PATH + "`?", "g");

/** Текст раздела: ссылки на другие документы базы становятся кликабельными, искомые слова подсвечены. */
function inline(text: string, kb: KbIndex | null, onDoc?: (doc: string) => void, highlight?: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(FILE)) {
    const label = m[1];
    const doc = kb?.byFile.get(m[2] ?? m[3]);
    if (!doc || !onDoc) {
      if (!label) continue;
      // ссылка на неизвестный файл — оставляем только текст
      out.push(<Fragment key={`t${last}`}>{mark(text.slice(last, m.index), highlight)}</Fragment>, label);
      last = m.index! + m[0].length;
      continue;
    }
    out.push(<Fragment key={`t${last}`}>{mark(text.slice(last, m.index), highlight)}</Fragment>);
    out.push(
      <button
        key={`l${m.index}`}
        type="button"
        onClick={() => onDoc(doc.doc)}
        className="font-medium text-brand underline-offset-2 hover:underline"
      >
        {label ?? doc.title}
      </button>,
    );
    last = m.index! + m[0].length;
  }
  out.push(<Fragment key={`t${last}`}>{mark(text.slice(last), highlight)}</Fragment>);
  return out;
}

function mark(text: string, highlight?: string): ReactNode[] {
  const q = highlight?.trim();
  if (!q || q.length < 2) return [text];
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return parts.map((p, i) =>
    i % 2 ? (
      <mark key={i} className="rounded-sm bg-yellow-200 px-0.5 dark:bg-yellow-700/60">
        {p}
      </mark>
    ) : (
      <Fragment key={i}>{p}</Fragment>
    ),
  );
}

export function ChunkText({
  text,
  kb,
  onDoc,
  highlight,
  className,
}: {
  text: string;
  kb: KbIndex | null;
  onDoc?: (doc: string) => void;
  highlight?: string;
  className?: string;
}) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const list = /^(-|\d+\.)\s/.test(line);
    const content = line.replace(/^-\s+/, "");
    const prev = blocks[blocks.length - 1];
    if (prev && prev.list === list && list) prev.lines.push(content);
    else blocks.push({ list, lines: [content] });
  }
  return (
    <div className={cn("space-y-2 text-sm leading-relaxed", className)}>
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i} className="list-disc space-y-1 pl-5 marker:text-muted-foreground">
            {b.lines.map((l, j) => (
              <li key={j}>{inline(l, kb, onDoc, highlight)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{inline(b.lines[0], kb, onDoc, highlight)}</p>
        ),
      )}
    </div>
  );
}
