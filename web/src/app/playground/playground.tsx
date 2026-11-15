"use client";

import { Check, ChevronDown, Download, FileJson, PanelRight, Pencil, Trash2 } from "lucide-react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AppShell, PageBar } from "@/components/app-shell";
import { ChatView } from "@/components/chat/chat-view";
import { exportSession, SessionsList } from "@/components/sessions-sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChat } from "@/hooks/use-chat";
import { useKb } from "@/hooks/use-kb";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { ChatMode } from "@/lib/types";
import { cn } from "@/lib/utils";

// Тяжёлые части экрана — отдельными чанками: разбор ответа, лист раздела базы и заявка не нужны для первого экрана.
const DebugPanel = dynamic(() => import("@/components/debug/debug-panel").then((m) => m.DebugPanel), { ssr: false });
const ChunkSheet = dynamic(() => import("@/components/kb/chunk-sheet").then((m) => m.ChunkSheet), { ssr: false });
const LeadDialog = dynamic(() => import("@/components/chat/lead-dialog").then((m) => m.LeadDialog), { ssr: false });

const DEBUG_KEY = "eb.debug.open";

const MODES: { value: ChatMode; short: string; label: string; hint: string }[] = [
  {
    value: "chat",
    short: "Чат",
    label: "Чат с клиентом",
    hint: "Как на сайте: бот может предложить передать запрос менеджеру.",
  },
  {
    value: "eval",
    short: "Как на проверке",
    label: "Как на платформе проверки",
    hint: "Ответ одной строкой без предложений заявки и контактов — так бота оценивает жюри.",
  },
];

export function Playground() {
  const [mode, setMode] = useState<ChatMode>("chat");
  const chat = useChat("eb.playground.sessions.v1", mode);
  const { kb } = useKb();
  const wide = useMediaQuery("(min-width: 1024px)", true);
  const [picked, setPicked] = useState<string>("");
  const [chunk, setChunk] = useState<string | null>(null);
  const [leadOpen, setLeadOpen] = useState(false);
  const [debugPref, setDebugPref] = useState(true);
  const [debugSheet, setDebugSheet] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- настройка хранится в браузере
    setDebugPref(localStorage.getItem(DEBUG_KEY) !== "0");
  }, []);

  // «Новый диалог» со страниц базы и виджета приходит сюда как ?new=1, диалог из палитры ⌘K — как ?s=<id>.
  const wantsNew = params.get("new") === "1";
  const wantsSession = params.get("s");
  useEffect(() => {
    if (!chat.ready || (!wantsNew && !wantsSession)) return;
    if (wantsNew) chat.create();
    else if (wantsSession) chat.select(wantsSession);
    router.replace(pathname, { scroll: false });
  }, [chat, wantsNew, wantsSession, router, pathname]);

  const messages = useMemo(() => chat.active?.messages ?? [], [chat.active]);
  // Отладка показывает выбранный ответ; если он из другого диалога — последний ответ текущего.
  const selected = useMemo(() => {
    const own = messages.find((m) => m.id === picked && m.role === "assistant");
    return own ?? [...messages].reverse().find((m) => m.role === "assistant");
  }, [messages, picked]);
  const question = selected ? messages[messages.indexOf(selected) - 1]?.content : undefined;
  const marked = useMemo(
    () => new Set(selected?.answer?.retrieval?.context.chunk_ids ?? selected?.retrieval?.context.chunk_ids ?? []),
    [selected],
  );

  const debugOpen = wide ? debugPref : debugSheet;
  const setDebugOpen = (open: boolean) => {
    if (wide) {
      setDebugPref(open);
      localStorage.setItem(DEBUG_KEY, open ? "1" : "0");
    } else setDebugSheet(open);
  };

  const debug = (
    <DebugPanel
      message={selected}
      question={question}
      kb={kb}
      onOpenChunk={setChunk}
      onClose={() => setDebugOpen(false)}
    />
  );
  const hasMessages = !!chat.active?.messages.length;

  const active = chat.active;
  const commitRename = (value: string) => {
    if (active && value.trim()) chat.rename(active.id, value.trim());
    setRenaming(null);
  };
  // Название диалога открывает меню действий — как заголовок чата в Claude.
  const title =
    hasMessages && active ? (
      renaming === active.id ? (
        <input
          autoFocus
          defaultValue={active.title}
          onBlur={(e) => commitRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename(e.currentTarget.value);
            if (e.key === "Escape") setRenaming(null);
          }}
          aria-label="Название диалога"
          className="h-8 w-[min(28rem,100%)] rounded-md border border-input bg-background px-2 text-[14px] font-medium outline-none focus:border-ring"
        />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="-ml-1 flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-[14px] font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted"
                aria-label={`Действия с диалогом «${active.title}»`}
              />
            }
          >
            <span className="truncate">{active.title}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onClick={() => setRenaming(active.id)}>
              <Pencil /> Переименовать
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportSession(active, "md")}>
              <Download /> Экспорт в Markdown
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => exportSession(active, "json")}>
              <FileJson /> Экспорт с отладкой (JSON)
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => chat.remove(active.id)}>
              <Trash2 /> Удалить
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )
    ) : undefined;

  const bar = (
    <PageBar title={title}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground"
              aria-label="Режим ответа"
            />
          }
        >
          {MODES.find((m) => m.value === mode)?.short}
          <ChevronDown className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {MODES.map((m) => (
            <DropdownMenuItem key={m.value} onClick={() => setMode(m.value)} className="items-start py-2">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{m.label}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-muted-foreground">{m.hint}</span>
              </span>
              <Check className={cn("mt-0.5", mode !== m.value && "invisible")} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {hasMessages && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("text-muted-foreground", debugOpen && "bg-muted text-foreground")}
                onClick={() => setDebugOpen(!debugOpen)}
                aria-label={debugOpen ? "Скрыть разбор ответа" : "Показать разбор ответа"}
                aria-pressed={debugOpen}
              />
            }
          >
            <PanelRight />
          </TooltipTrigger>
          <TooltipContent>{debugOpen ? "Скрыть разбор ответа" : "Показать разбор ответа"}</TooltipContent>
        </Tooltip>
      )}
    </PageBar>
  );

  const chatColumn = (
    <div className="flex h-full min-h-0 flex-col">
      {bar}
      <div className="min-h-0 flex-1">
        {chat.ready && (
          <ChatView
            chat={chat}
            kb={kb}
            onOpenChunk={setChunk}
            selectedId={wide && debugOpen ? selected?.id : undefined}
            onSelect={(id, explicit) => {
              setPicked(id);
              if (explicit) setDebugOpen(true);
            }}
            onLead={() => setLeadOpen(true)}
          />
        )}
      </div>
    </div>
  );

  return (
    <AppShell
      onNew={() => chat.create()}
      onSelectSession={(id) => chat.select(id)}
      sidebar={chat.ready ? <SessionsList chat={chat} /> : null}
    >
      {wide ? (
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="60%" minSize="40%">
            {chatColumn}
          </ResizablePanel>
          {debugOpen && hasMessages && (
            <>
              <ResizableHandle className="bg-border" />
              <ResizablePanel defaultSize="40%" minSize="28%">
                <div className="h-full bg-background">{debug}</div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      ) : (
        <>
          {chatColumn}
          <Sheet open={debugSheet} onOpenChange={setDebugSheet}>
            <SheetContent
              side="right"
              showCloseButton={false}
              className="w-full gap-0 bg-background p-0 data-[side=right]:w-[min(560px,100vw)] data-[side=right]:sm:max-w-none"
            >
              <SheetTitle className="sr-only">Отладка ответа</SheetTitle>
              {debug}
            </SheetContent>
          </Sheet>
        </>
      )}
      <ChunkSheet kb={kb} chunkId={chunk} onClose={() => setChunk(null)} marked={marked} />
      {chat.active && (
        <LeadDialog
          session={chat.active}
          open={leadOpen}
          onOpenChange={setLeadOpen}
          onDone={(lead) => chat.setLead(lead)}
        />
      )}
    </AppShell>
  );
}
