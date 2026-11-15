"use client";

import { CheckCircle2, Headset, PanelRight } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ChatController } from "@/hooks/use-chat";
import type { KbIndex } from "@/hooks/use-kb";
import { sendFeedback } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { MessageItem } from "./message-item";
import { BrandGlyph } from "@/components/brand";
import { Shortcut } from "@/components/shortcut";
import { SourceNumber } from "./answer-text";
import { Starters } from "./starters";

const GREETING =
  "Подберу решение по базе знаний МТС EnergyTool: учёт электроэнергии, поиск потерь, солнечная генерация, оптовый рынок и тарифы. Опишите задачу своими словами.";

/** «Передать менеджеру» — тихая кнопка в нижней строке поля ввода, как инструменты в поле Claude. */
function LeadButton({ done, onClick }: { done?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {done ? (
        <>
          <CheckCircle2 className="size-3.5 shrink-0 text-success" />
          <span className="truncate">Заявка №{done} передана</span>
        </>
      ) : (
        <>
          <Headset className="size-3.5 shrink-0" />
          <span className="truncate">Передать менеджеру</span>
        </>
      )}
    </button>
  );
}

/** Как читать стенд — одна тихая строка внизу пустого экрана: три вещи, которые жюри стоит знать. */
function StandHints() {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12px] text-muted-foreground">
      <li className="flex items-center gap-1.5">
        <SourceNumber n={1} />у каждого факта — раздел базы, откуда он
      </li>
      <li className="flex items-center gap-1.5">
        <PanelRight className="size-3.5" />
        разбор ответа: поиск, контекст, промпт, проверка
      </li>
      <li className="flex items-center gap-1.5">
        <Shortcut keys={["mod", "K"]} className="-mx-0.5" />
        поиск по диалогам и базе
      </li>
    </ul>
  );
}

export function ChatView({
  chat,
  kb,
  onOpenChunk,
  selectedId,
  onSelect,
  onLead,
  compact,
  greeting,
  prefill,
  disabled,
}: {
  chat: ChatController;
  kb: KbIndex | null;
  onOpenChunk: (chunkId: string) => void;
  selectedId?: string;
  /** explicit — пользователь сам попросил показать отладку этого ответа. */
  onSelect?: (messageId: string, explicit?: boolean) => void;
  onLead?: () => void;
  compact?: boolean;
  greeting?: string;
  prefill?: { text: string; nonce: number };
  disabled?: boolean;
}) {
  const bottom = useRef<HTMLDivElement>(null);
  const messages = chat.active?.messages ?? [];
  const last = messages[messages.length - 1];

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, last?.pending, last?.stage]);

  const send = (text: string) => {
    const id = chat.send(text);
    if (id) onSelect?.(id);
  };

  const rate = (messageId: string, rating: 1 | -1) => {
    const index = messages.findIndex((m) => m.id === messageId);
    chat.rate(messageId, rating);
    void sendFeedback({
      session_id: chat.activeId,
      message_id: messageId,
      rating,
      question: messages[index - 1]?.content,
      answer: messages[index]?.content,
    });
    toast.success(rating > 0 ? "Спасибо за оценку" : "Спасибо, учтём при доработке");
  };

  const hasAnswers = messages.some((m) => m.role === "assistant" && m.answer);
  // В виджете связь с менеджером видна сразу — клиент может не захотеть говорить с ботом; на стенде — после ответа.
  const leadInline = onLead && (compact || hasAnswers);
  const composer = (
    <Composer
      tools={leadInline ? <LeadButton done={chat.active?.lead?.id} onClick={onLead} /> : undefined}
      onSend={send}
      onStop={chat.stop}
      busy={chat.busy}
      compact={compact}
      placeholder={compact ? "Опишите вашу задачу" : undefined}
      disabled={disabled}
      value={prefill}
      autoFocus={!compact}
    />
  );

  // Пустой стенд — как в Claude: знак и вопрос, поле ввода, подсказки; внизу — как читать стенд.
  if (!messages.length && !compact) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[680px] flex-1 flex-col justify-center px-5 pt-6 pb-[10vh] sm:px-6">
          <div className="msg-in flex flex-col items-center text-center">
            <h1 className="flex items-center gap-3 text-[24px] leading-tight font-medium tracking-[-0.022em]">
              <BrandGlyph className="size-7 sm:size-8" />
              Чем помочь с электроэнергией?
            </h1>
            <p className="mt-2 max-w-[34rem] text-[14px] leading-relaxed text-pretty text-muted-foreground">
              {greeting ?? "Отвечаю только по базе знаний МТС EnergyTool и показываю источник каждого факта."}
            </p>
          </div>
          <div className="mt-7">{composer}</div>
          <div className="mt-3">
            <Starters onPick={send} />
          </div>
        </div>
        <div className="shrink-0 px-5 pb-5">
          <StandHints />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto flex w-full flex-col",
            compact ? "gap-5 px-5 pt-4 pb-6" : "max-w-[720px] gap-6 px-5 pt-6 pb-10 sm:px-6",
          )}
        >
          {!messages.length && compact && (
            <div className="msg-in pt-2">
              <BrandGlyph className="size-7" />
              <h2 className="mt-3 text-[18px] leading-snug font-semibold tracking-[-0.015em]">Здравствуйте! Чем помочь?</h2>
              <p className="mt-1.5 text-[14px] leading-relaxed text-pretty text-muted-foreground">{greeting ?? GREETING}</p>
              <div className="mt-5">
                <Starters onPick={send} compact />
              </div>
            </div>
          )}
          {messages.map((m) => (
            <MessageItem
              key={m.id}
              message={m}
              kb={kb}
              compact={compact}
              onOpenChunk={onOpenChunk}
              selected={selectedId === m.id}
              onDebug={onSelect && m.role === "assistant" ? () => onSelect(m.id, true) : undefined}
              onRegenerate={
                m.role === "assistant" && !chat.busy
                  ? () => {
                      const id = chat.regenerate(m.id);
                      if (id) onSelect?.(id);
                    }
                  : undefined
              }
              onRate={m.role === "assistant" && m.answer ? (r) => rate(m.id, r) : undefined}
            />
          ))}
          <div ref={bottom} />
        </div>
      </div>
      <div className={cn("shrink-0", compact ? "px-3 pt-1 pb-1.5" : "mx-auto w-full max-w-[720px] px-4 pb-3 sm:px-6")}>
        {composer}
        {!compact && (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            Ответы строятся только по базе знаний МТС EnergyTool. Цифры по вашему объекту подтвердит специалист.
          </p>
        )}
      </div>
    </div>
  );
}
