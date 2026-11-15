"use client";

import { ChevronDown, Download, FileJson, Loader2, MoreHorizontal, Pencil, Trash2, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatController } from "@/hooks/use-chat";
import type { Session } from "@/lib/types";
import { cn } from "@/lib/utils";

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportSession(s: Session, format: "md" | "json") {
  const stamp = new Date(s.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  if (format === "json") {
    download(`energytool-${stamp}.json`, JSON.stringify(s, null, 2), "application/json");
    return;
  }
  const lines = [`# ${s.title}`, "", `Дата: ${new Date(s.createdAt).toLocaleString("ru")}`, ""];
  for (const m of s.messages) {
    if (m.error) continue;
    lines.push(m.role === "user" ? `**Клиент:** ${m.content}` : `**Консультант:** ${m.content}`, "");
    const sources = m.answer?.sources ?? [];
    if (sources.length) {
      lines.push(`> Источники: ${sources.map((x) => x.title + (x.path ? ` › ${x.path}` : "")).join("; ")}`, "");
    }
  }
  if (s.lead) lines.push("## Заявка менеджеру", "", s.lead.summary, "");
  download(`energytool-${stamp}.md`, lines.join("\n"), "text/markdown");
}

/**
 * «Недавние» как в Claude: плоский список названий без иконок, свежие сверху.
 * Заголовок сворачивает список; «…» у строки — действия с диалогом.
 */
export function SessionsList({ chat, query = "", onPicked }: { chat: ChatController; query?: string; onPicked?: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [folded, setFolded] = useState(false);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...chat.sessions]
      .filter((s) => s.messages.length > 0)
      .filter(
        (s) => !q || s.title.toLowerCase().includes(q) || s.messages.some((m) => m.content.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [chat.sessions, query]);

  const commit = () => {
    if (editing && draft.trim()) chat.rename(editing, draft.trim());
    setEditing(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <button
        type="button"
        onClick={() => setFolded((v) => !v)}
        aria-expanded={!folded}
        className="mx-2 flex h-8 w-fit shrink-0 items-center gap-1 rounded-md px-2.5 text-[13px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {query ? "Найдено" : "Недавние"}
        <ChevronDown className={cn("size-3.5 transition-transform duration-200", folded && "-rotate-90")} />
      </button>
      {!folded && (
        <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-3">
          {!list.length && (
            <p className="px-2.5 py-2 text-[13px] leading-relaxed text-muted-foreground">
              {query ? "Ничего не нашлось. Попробуйте другое слово." : "Здесь появятся ваши диалоги."}
            </p>
          )}
          {list.map((s) => {
            const active = s.id === chat.activeId;
            const pending = s.messages.some((m) => m.pending);
            return (
              <div
                key={s.id}
                className={cn(
                  "group relative flex h-9 items-center rounded-lg text-[14px] transition-colors hover:bg-sidebar-accent",
                  active && "bg-sidebar-accent",
                )}
              >
                {editing === s.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit();
                      if (e.key === "Escape") setEditing(null);
                    }}
                    aria-label="Название диалога"
                    className="mx-1 h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[14px] outline-none focus:border-ring"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      chat.select(s.id);
                      onPicked?.();
                    }}
                    aria-current={active ? "true" : undefined}
                    className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pr-9 pl-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <span className="truncate text-sidebar-foreground">{s.title}</span>
                    {s.lead && <UserRound className="size-3.5 shrink-0 text-success" aria-label="заявка передана" />}
                  </button>
                )}
                {editing !== s.id && pending && (
                  <Loader2
                    className="pointer-events-none absolute right-2.5 size-3.5 animate-spin text-muted-foreground group-hover:opacity-0"
                    aria-label="отвечает"
                  />
                )}
                {editing !== s.id && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="absolute right-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-transparent hover:text-foreground focus-visible:opacity-100 aria-expanded:opacity-100"
                          aria-label="Действия с диалогом"
                        />
                      }
                    >
                      <MoreHorizontal className="size-4!" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-52">
                      <DropdownMenuItem
                        onClick={() => {
                          setDraft(s.title);
                          setEditing(s.id);
                        }}
                      >
                        <Pencil /> Переименовать
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => exportSession(s, "md")}>
                        <Download /> Экспорт в Markdown
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => exportSession(s, "json")}>
                        <FileJson /> Экспорт с отладкой (JSON)
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => chat.remove(s.id)}>
                        <Trash2 /> Удалить
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
