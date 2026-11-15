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
        className="font-medium text-brand-text underline decoration-brand-text/30 underline-offset-[3px] hover:decoration-brand-text"
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
      <mark key={i} className="rounded-[3px] bg-primary px-0.5 text-white">
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
  focusLine,
  className,
}: {
  text: string;
  kb: KbIndex | null;
  onDoc?: (doc: string) => void;
  highlight?: string;
  /** Строка раздела, на которую опирается ответ: помечается data-line и плавно подсвечивается. */
  focusLine?: number;
  className?: string;
}) {
  const blocks: { list: boolean; ordered: boolean; lines: string[]; idx: number[] }[] = [];
  // idx — номер строки среди непустых: по нему ссылка из ответа находит нужное место (lib/line-match.ts)
  let n = -1;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    n++;
    const list = /^\s*(-|\d+\.)\s/.test(line);
    const ordered = /^\s*\d+\.\s/.test(line);
    const content = line.replace(/^\s*(-|\d+\.)\s+/, "");
    const prev = blocks[blocks.length - 1];
    if (prev && list && prev.list && prev.ordered === ordered) {
      prev.lines.push(content);
      prev.idx.push(n);
    } else blocks.push({ list, ordered, lines: [content], idx: [n] });
  }
  const at = (i: number) => ({ "data-line": i, "data-hl": i === focusLine ? "" : undefined });
  const ink = (l: string) => inline(l, kb, onDoc, highlight);
  return (
    <div className={cn("space-y-3", className ?? "text-[14px] leading-relaxed")}>
      {blocks.map((b, i) => {
        if (!b.list) return <p key={i} {...at(b.idx[0])} className="line-mark">{ink(b.lines[0])}</p>;
        const rows = b.lines.map(pairs);
        const keys = rows[0]?.map(([k]) => k).join("|");
        // «Показатель: …; Значение: …; Оговорка: …» в каждой строке — это таблица, записанная текстом.
        if (rows.length > 1 && rows.every((r) => r && r.length > 1 && r.map(([k]) => k).join("|") === keys)) {
          return <KvTable key={i} head={rows[0]!.map(([k]) => k)} rows={rows as [string, string][][]} idx={b.idx} at={at} ink={ink} />;
        }
        // «Кто: …», «Что: …» — пары «ключ — значение» по одной в строке.
        if (rows.every((r) => r && r.length === 1) && rows.length > 1) {
          return (
            <dl key={i} className="divide-y overflow-hidden rounded-xl border">
              {(rows as [string, string][][]).map(([[k, v]], j) => (
                <div key={j} {...at(b.idx[j])} className="line-mark grid gap-1 px-4 py-2.5 sm:grid-cols-[minmax(0,12rem)_1fr] sm:gap-4">
                  <dt className="text-[13px] font-medium text-muted-foreground sm:pt-px">{k}</dt>
                  <dd>{ink(v)}</dd>
                </div>
              ))}
            </dl>
          );
        }
        if (rows.length === 1 && rows[0] && rows[0].length > 1) {
          return (
            <dl key={i} {...at(b.idx[0])} className="line-mark grid gap-x-4 gap-y-1.5 rounded-xl border px-4 py-3 sm:grid-cols-[minmax(0,12rem)_1fr]">
              {rows[0].map(([k, v], j) => (
                <div key={j} className="contents">
                  <dt className="text-[13px] font-medium text-muted-foreground sm:pt-px">{k}</dt>
                  <dd>{ink(v)}</dd>
                </div>
              ))}
            </dl>
          );
        }
        const List = b.ordered ? "ol" : "ul";
        return (
          <List
            key={i}
            className={cn(
              "space-y-2 pl-5",
              b.ordered ? "list-decimal marker:text-[13px] marker:font-medium marker:text-muted-foreground" : "list-none",
            )}
          >
            {b.lines.map((l, j) => (
              <li
                key={j}
                {...at(b.idx[j])}
                className={cn(
                  "line-mark relative",
                  !b.ordered &&
                    "before:absolute before:top-[0.72em] before:-left-4 before:h-px before:w-2 before:bg-dim",
                )}
              >
                {ink(l)}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

/** «Ключ: значение; Ключ: значение» → пары; null, если строка устроена иначе. */
function pairs(line: string): [string, string][] | null {
  const parts = line.split(/;\s+(?=[^:;]{2,40}:\s)/);
  const out: [string, string][] = [];
  for (const part of parts) {
    const m = part.match(/^([^:;]{2,40}):\s+(.+)$/);
    if (!m) return null;
    out.push([m[1].trim(), m[2].trim().replace(/;$/, "")]);
  }
  return out;
}

function KvTable({
  head,
  rows,
  idx,
  at,
  ink,
}: {
  head: string[];
  rows: [string, string][][];
  idx: number[];
  at: (i: number) => Record<string, unknown>;
  ink: (text: string) => ReactNode[];
}) {
  // На узких экранах строка таблицы превращается в карточку «подпись — значение».
  return (
    <div className="overflow-hidden rounded-xl border">
      <table className="w-full border-collapse text-left text-[13.5px] leading-snug max-sm:block">
        <thead className="max-sm:hidden">
          <tr className="bg-surface">
            {head.map((h) => (
              <th key={h} scope="col" className="px-3.5 py-2.5 text-[12.5px] font-medium whitespace-nowrap text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y border-t max-sm:block max-sm:border-t-0">
          {rows.map((r, i) => (
            <tr key={i} {...at(idx[i])} className="line-mark align-top max-sm:block max-sm:space-y-2 max-sm:px-3.5 max-sm:py-3">
              {r.map(([, v], j) => (
                <td
                  key={j}
                  data-label={head[j]}
                  className={cn(
                    "px-3.5 py-2.5 max-sm:block max-sm:p-0 max-sm:before:mb-0.5 max-sm:before:block max-sm:before:text-xs max-sm:before:font-medium max-sm:before:text-muted-foreground max-sm:before:content-[attr(data-label)]",
                    j === 0 && "font-medium",
                    j > 0 && "text-foreground/90",
                  )}
                >
                  {ink(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
