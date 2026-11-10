"use client";

import { Download, FileJson, MoreHorizontal, Pencil, Search, Trash2, UserRound, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarLabel } from "@/components/app-shell";
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

function bucket(ts: number) {
  const day = 86_400_000;
  const start = new Date().setHours(0, 0, 0, 0);
  if (ts >= start) return "Сегодня";
  if (ts >= start - day) return "Вчера";
  if (ts >= start - 7 * day) return "Последние 7 дней";
  return "Ранее";
}

export function SessionsList({ chat, onPicked }: { chat: ChatController; onPicked?: () => void }) {
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = [...chat.sessions]
      .filter((s) => s.messages.length > 0)
      .filter(
        (s) =>
          !query ||
          s.title.toLowerCase().includes(query) ||
          s.messages.some((m) => m.content.toLowerCase().includes(query)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const out = new Map<string, Session[]>();
    for (const s of list) out.set(bucket(s.updatedAt), [...(out.get(bucket(s.updatedAt)) ?? []), s]);
    return [...out.entries()];
  }, [chat.sessions, q]);

  const commit = () => {
    if (editing && draft.trim()) chat.rename(editing, draft.trim());
    setEditing(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2">
        <label className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-muted-foreground transition-colors focus-within:bg-sidebar-accent hover:bg-sidebar-accent">
          <Search className="size-4 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Поиск по диалогам"
            aria-label="Поиск по диалогам"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          {q && (
            <button type="button" onClick={() => setQ("")} aria-label="Очистить поиск" className="hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!groups.length && (
          <p className="px-2.5 py-4 text-[13px] text-muted-foreground">
            {q ? "Ничего не нашлось. Попробуйте другое слово." : "Здесь появятся ваши диалоги."}
          </p>
        )}
        {groups.map(([label, list]) => (
          <section key={label} aria-label={label}>
            <SidebarLabel>{label}</SidebarLabel>
            {list.map((s) => {
              const active = s.id === chat.activeId;
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
                      className="flex h-full min-w-0 flex-1 items-center gap-2 pr-8 pl-2.5 text-left"
                    >
                      <span className={cn("truncate", active ? "text-foreground" : "text-sidebar-foreground/85")}>
                        {s.title}
                      </span>
                      {s.messages.some((m) => m.pending) && (
                        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" aria-label="отвечает" />
                      )}
                      {s.lead && (
                        <UserRound className="size-3.5 shrink-0 text-success" aria-label="заявка передана" />
                      )}
                    </button>
                  )}
                  {editing !== s.id && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            className={cn(
                              "absolute right-1.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-transparent hover:text-foreground focus-visible:opacity-100 aria-expanded:opacity-100",
                              active && "opacity-100",
                            )}
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
          </section>
        ))}
      </div>
    </div>
  );
}
