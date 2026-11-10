"use client";

import { Download, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useMemo, useState } from "react";
import { ChatView } from "@/components/chat/chat-view";
import { LeadDialog } from "@/components/chat/lead-dialog";
import { DebugPanel } from "@/components/debug/debug-panel";
import { ChunkSheet } from "@/components/kb/chunk-sheet";
import { exportSession, SessionsSidebar } from "@/components/sessions-sidebar";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChat } from "@/hooks/use-chat";
import { useKb } from "@/hooks/use-kb";
import type { ChatMode } from "@/lib/types";

export function Playground() {
  const [mode, setMode] = useState<ChatMode>("chat");
  const chat = useChat("eb.playground.sessions.v1", mode);
  const { kb } = useKb();
  const [picked, setPicked] = useState<string>("");
  const [chunk, setChunk] = useState<string | null>(null);
  const [leadOpen, setLeadOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(true);

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

  if (!chat.ready) return <div className="flex-1" />;

  return (
    <div className="flex min-h-0 flex-1">
      <SessionsSidebar chat={chat} onNew={() => chat.create()} />
      <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1">
        <ResizablePanel defaultSize="58%" minSize="35%">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
              <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{chat.active?.title}</h1>
              <Tooltip>
                <TooltipTrigger
                  render={<label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground" />}
                >
                  <Switch
                    checked={mode === "eval"}
                    onCheckedChange={(v) => setMode(v ? "eval" : "chat")}
                    size="sm"
                  />
                  Режим автопроверки
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">
                  Как на платформе жюри: бот не предлагает оставить заявку и не просит контакты. В обычном режиме
                  он может предложить передать запрос менеджеру.
                </TooltipContent>
              </Tooltip>
              {chat.active && chat.active.messages.length > 0 && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => exportSession(chat.active!, "md")}
                        aria-label="Экспорт диалога"
                      />
                    }
                  >
                    <Download />
                  </TooltipTrigger>
                  <TooltipContent>Экспорт диалога в Markdown</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setDebugOpen((v) => !v)}
                      aria-label="Панель отладки"
                    />
                  }
                >
                  {debugOpen ? <PanelRightClose /> : <PanelRightOpen />}
                </TooltipTrigger>
                <TooltipContent>{debugOpen ? "Скрыть отладку" : "Показать отладку"}</TooltipContent>
              </Tooltip>
            </div>
            <div className="min-h-0 flex-1">
              <ChatView
                chat={chat}
                kb={kb}
                onOpenChunk={setChunk}
                selectedId={selected?.id}
                onSelect={(id) => {
                  setPicked(id);
                  setDebugOpen(true);
                }}
                onLead={() => setLeadOpen(true)}
              />
            </div>
          </div>
        </ResizablePanel>
        {debugOpen && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="42%" minSize="28%">
              <div className="h-full bg-muted/20">
                <DebugPanel message={selected} question={question} kb={kb} onOpenChunk={setChunk} />
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <ChunkSheet kb={kb} chunkId={chunk} onClose={() => setChunk(null)} marked={marked} />
      {chat.active && (
        <LeadDialog
          session={chat.active}
          open={leadOpen}
          onOpenChange={setLeadOpen}
          onDone={(lead) => chat.setLead(lead)}
        />
      )}
    </div>
  );
}
