"use client";

import { FileText, MessageSquare, SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useState } from "react";
import { NAV, SESSIONS_KEY, THEMES } from "@/components/nav-items";
import { Shortcut } from "@/components/shortcut";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { useKb } from "@/hooks/use-kb";
import type { Session } from "@/lib/types";

/*
 * Палитра ⌘K отдельным чанком: cmdk и список базы грузятся при первом открытии, а не с каждой страницей.
 */

function readSessions(): Session[] {
  try {
    const list = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]") as Session[];
    return list.filter((s) => s.messages.length > 0).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export default function CommandPalette({
  close,
  onNew,
  onSelectSession,
}: {
  close: () => void;
  onNew?: () => void;
  onSelectSession?: (id: string) => void;
}) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const [sessions] = useState(readSessions);
  const { kb } = useKb();
  const run = (fn: () => void) => {
    close();
    fn();
  };

  return (
    <Command className="rounded-none! bg-transparent p-1">
      <CommandInput placeholder="Найти диалог, документ или команду…" />
      <CommandList className="max-h-[min(60vh,420px)]">
        <CommandEmpty>Ничего не нашлось</CommandEmpty>
        <CommandGroup heading="Действия">
          <CommandItem value="новый диалог" onSelect={() => run(() => (onNew ? onNew() : router.push("/playground?new=1")))}>
            <SquarePen /> Новый диалог
            <CommandShortcut>
              <Shortcut keys={["mod", "shift", "O"]} />
            </CommandShortcut>
          </CommandItem>
          {THEMES.map(({ value, label, icon: Icon }) => (
            <CommandItem key={value} value={label} onSelect={() => run(() => setTheme(value))}>
              <Icon /> {label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Разделы">
          {NAV.map(({ href, label, icon: Icon }) => (
            <CommandItem key={href} value={label} onSelect={() => run(() => router.push(href))}>
              <Icon /> {label}
            </CommandItem>
          ))}
        </CommandGroup>
        {sessions.length > 0 && (
          <CommandGroup heading="Диалоги">
            {sessions.slice(0, 30).map((s) => (
              <CommandItem
                key={s.id}
                value={`${s.title} ${s.id}`}
                keywords={s.messages.slice(0, 4).map((m) => m.content.slice(0, 80))}
                onSelect={() =>
                  run(() => (onSelectSession ? onSelectSession(s.id) : router.push(`/playground?s=${s.id}`)))
                }
              >
                <MessageSquare /> <span className="min-w-0 flex-1 truncate">{s.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {kb && (
          <CommandGroup heading="База знаний">
            {kb.data.docs.map((d) => (
              <CommandItem
                key={d.doc}
                value={`${d.title} ${d.doc}`}
                onSelect={() => run(() => router.push(`/kb?doc=${encodeURIComponent(d.doc)}`))}
              >
                <FileText /> <span className="min-w-0 flex-1 truncate">{d.title}</span>
                {/* data-slot прячет пустую галочку пункта, и имя файла встаёт ровно к правому краю */}
                <span data-slot="command-shortcut" className="ml-auto shrink-0 pl-3 text-right font-mono text-[11px] text-muted-foreground">
                  {d.doc.split("/").pop()?.replace(/\.md$/, "")}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}

