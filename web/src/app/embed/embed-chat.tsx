"use client";

import { ArrowLeft, SquarePen, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChatView } from "@/components/chat/chat-view";
import { LeadPanel } from "@/components/chat/lead-dialog";
import { BrandMark } from "@/components/brand";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChat } from "@/hooks/use-chat";
import { kbHref } from "@/hooks/use-kb";
import { cn } from "@/lib/utils";

const HEX = /^#[0-9a-f]{3,8}$/i;

/** Чат внутри iframe виджета. Общается со страницей-хозяином через postMessage (origin из ?parent=). */
export function EmbedChat() {
  const params = useSearchParams();
  const title = params.get("title") || "Консультант EnergyTool";
  const subtitle = params.get("subtitle") || "Отвечает по базе знаний МТС";
  const greeting = params.get("greeting") || undefined;
  const color = HEX.test(params.get("color") ?? "") ? params.get("color")! : undefined;
  const parent = params.get("parent");
  const [embedded, setEmbedded] = useState(false);

  const chat = useChat("eb.widget.sessions.v1", "chat");
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

  // Виджет живёт на сайте клиента: главное действие — в цвете виджета (по умолчанию красный МТС), а не графитом стенда.
  const accent = color ?? "#FF0032";
  const style = {
    "--brand": accent,
    "--primary": accent,
    "--primary-foreground": "#ffffff",
    "--brand-text": accent,
    "--brand-soft": `color-mix(in oklch, ${accent} 9%, white)`,
  } as React.CSSProperties;

  const headerButton =
    "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [&_svg]:size-4";

  return (
    <div className="flex h-dvh flex-col bg-background" style={style}>
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b px-3.5">
        {leadOpen ? (
          <>
            <button
              type="button"
              onClick={() => setLeadOpen(false)}
              className={cn(headerButton, "-ml-1.5")}
              aria-label="Назад к чату"
            >
              <ArrowLeft />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] leading-tight font-semibold">Передать запрос менеджеру</div>
              <div className="mt-0.5 truncate text-[12px] text-muted-foreground">Менеджер получит резюме разговора</div>
            </div>
          </>
        ) : (
          <>
            <BrandMark className="size-7 rounded-[8px]" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] leading-tight font-semibold">{title}</div>
              <div className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-muted-foreground">
                <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
                <span className="truncate">{subtitle}</span>
              </div>
            </div>
          </>
        )}
        <div className="-mr-1 flex items-center gap-0.5">
          {!leadOpen && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button type="button" onClick={() => chat.create()} className={headerButton} aria-label="Новый диалог" />
                  }
                >
                  <SquarePen />
                </TooltipTrigger>
                <TooltipContent>Новый диалог</TooltipContent>
              </Tooltip>
            </>
          )}
          {embedded && (
            <button type="button" onClick={() => notify("eb:close")} className={headerButton} aria-label="Свернуть">
              <X />
            </button>
          )}
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {chat.ready && (
          <div className={cn("h-full", leadOpen && "invisible")} aria-hidden={leadOpen}>
            <ChatView
              chat={chat}
              kb={null}
              compact
              greeting={greeting}
              onOpenChunk={(id) => window.open(kbHref(id), "_blank", "noopener")}
              onLead={() => setLeadOpen(true)}
            />
          </div>
        )}
        {leadOpen && chat.active && (
          <div className="msg-in absolute inset-0 bg-background">
            <LeadPanel session={chat.active} onDone={(l) => chat.setLead(l)} onClose={() => setLeadOpen(false)} />
          </div>
        )}
      </div>
      {!leadOpen && (
        <div className="shrink-0 px-5 pb-2 text-center text-[11px] leading-snug text-muted-foreground">
          ИИ может ошибаться — цифры по вашему объекту подтвердит специалист МТС
        </div>
      )}
    </div>
  );
}
