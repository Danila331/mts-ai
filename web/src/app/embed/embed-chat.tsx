"use client";

import { MessageSquarePlus, UserRound, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChatView } from "@/components/chat/chat-view";
import { LeadDialog } from "@/components/chat/lead-dialog";
import { BotAvatar } from "@/components/chat/message-item";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChat } from "@/hooks/use-chat";
import { kbHref, useKb } from "@/hooks/use-kb";

const HEX = /^#[0-9a-f]{3,8}$/i;

/** Чат внутри iframe виджета. Общается со страницей-хозяином через postMessage (origin из ?parent=). */
export function EmbedChat() {
  const params = useSearchParams();
  const title = params.get("title") || "Консультант EnergyTool";
  const subtitle = params.get("subtitle") || "ИИ-помощник · отвечает по базе знаний МТС";
  const greeting = params.get("greeting") || undefined;
  const color = HEX.test(params.get("color") ?? "") ? params.get("color")! : undefined;
  const parent = params.get("parent");
  const [embedded, setEmbedded] = useState(false);

  const chat = useChat("eb.widget.sessions.v1", "chat");
  const { kb } = useKb();
  const [leadOpen, setLeadOpen] = useState(false);
  const sendRef = useRef(chat.send);
  const pending = useRef<string[]>([]);

  useEffect(() => {
    sendRef.current = chat.send;
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- window доступен только после монтирования
    setEmbedded(window.parent !== window);
  }, []);

  // Вопросы, пришедшие до загрузки истории, отправляем, как только чат готов.
  useEffect(() => {
    if (!chat.ready || !pending.current.length) return;
    for (const q of pending.current.splice(0)) sendRef.current(q);
  }, [chat.ready]);

  const notify = (type: string) => {
    if (embedded && parent) window.parent.postMessage({ type }, parent);
  };

  useEffect(() => {
    if (!embedded || !parent) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== parent || e.source !== window.parent) return;
      const data = e.data as { type?: string; text?: string };
      if (data?.type === "eb:ask" && data.text) {
        if (chat.ready) sendRef.current(data.text);
        else pending.current.push(data.text);
      } else if (data?.type === "eb:open") {
        document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && window.parent.postMessage({ type: "eb:close" }, parent);
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    window.parent.postMessage({ type: "eb:ready" }, parent);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
    };
  }, [embedded, parent, chat.ready]);

  // Новый ответ, пока виджет закрыт, — точка на кнопке.
  const answers = chat.active?.messages.filter((m) => m.role === "assistant" && m.answer).length ?? 0;
  const seen = useRef(answers);
  useEffect(() => {
    if (answers > seen.current) notify("eb:unread");
    seen.current = answers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers]);

  const style = color ? ({ "--brand": color } as React.CSSProperties) : undefined;

  return (
    <div className="flex h-dvh flex-col bg-background" style={style}>
      <header className="flex shrink-0 items-center gap-2.5 bg-[#1d2023] px-3.5 py-3 text-white">
        <BotAvatar className="size-9 text-xs" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div className="flex items-center gap-1.5 truncate text-[11px] text-white/60">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            {subtitle}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setLeadOpen(true)}
                className="text-white/80 hover:bg-white/10 hover:text-white"
                aria-label="Связаться с менеджером"
              />
            }
          >
            <UserRound />
          </TooltipTrigger>
          <TooltipContent>Связаться с менеджером</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => chat.create()}
                className="text-white/80 hover:bg-white/10 hover:text-white"
                aria-label="Новый диалог"
              />
            }
          >
            <MessageSquarePlus />
          </TooltipTrigger>
          <TooltipContent>Новый диалог</TooltipContent>
        </Tooltip>
        {embedded && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => notify("eb:close")}
            className="text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Свернуть"
          >
            <X />
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1">
        {chat.ready && (
          <ChatView
            chat={chat}
            kb={kb}
            compact
            greeting={greeting}
            onOpenChunk={(id) => window.open(kbHref(id), "_blank", "noopener")}
            onLead={() => setLeadOpen(true)}
          />
        )}
      </div>
      <div className="shrink-0 pb-2 text-center text-[10px] text-muted-foreground">
        ИИ может ошибаться · точные цифры по объекту подтвердит специалист МТС
      </div>
      {chat.active && (
        <LeadDialog session={chat.active} open={leadOpen} onOpenChange={setLeadOpen} onDone={(l) => chat.setLead(l)} />
      )}
    </div>
  );
}
