"use client";

import { Download, MoreHorizontal, Pencil, Plus, Search, Trash2, UserRound } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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

export function SessionsSidebar({ chat, onNew }: { chat: ChatController; onNew: () => void }) {
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    const list = [...chat.sessions]
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
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-sidebar">
      <div className="space-y-2 p-3">
        <Button onClick={onNew} className="w-full justify-start" variant="outline">
          <Plus /> Новый диалог
        </Button>
        <div className="relative">
          <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по диалогам" className="h-8 pl-8 text-xs" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.map(([label, list]) => (
          <div key={label} className="mb-3">
            <div className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{label}</div>
            {list.map((s) => (
              <div
                key={s.id}
                className={cn(
                  "group flex items-center rounded-lg pr-1 text-sm transition-colors hover:bg-sidebar-accent",
                  s.id === chat.activeId && "bg-sidebar-accent font-medium",
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
                    className="m-1 h-7 flex-1 rounded-md border bg-background px-2 text-sm outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => chat.select(s.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
                  >
                    <span className="truncate">{s.title}</span>
                    {s.lead && <UserRound className="size-3 shrink-0 text-emerald-600" aria-label="заявка передана" />}
                    {s.messages.some((m) => m.pending) && (
                      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" />
                    )}
                  </button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="opacity-0 group-hover:opacity-100 aria-expanded:opacity-100"
                        aria-label="Действия с диалогом"
                      />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
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
                      <Download /> Экспорт с отладкой (JSON)
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => chat.remove(s.id)}>
                      <Trash2 /> Удалить
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="border-t p-3 text-[11px] leading-snug text-muted-foreground">
        Диалоги хранятся в этом браузере. Отладка сохраняется вместе с ответами.
      </div>
    </aside>
  );
}
