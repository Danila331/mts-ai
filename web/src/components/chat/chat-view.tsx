"use client";

import { UserRound } from "lucide-react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ChatController } from "@/hooks/use-chat";
import type { KbIndex } from "@/hooks/use-kb";
import { sendFeedback } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { BotAvatar, MessageItem } from "./message-item";
import { Starters } from "./starters";

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
  onSelect?: (messageId: string) => void;
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex flex-col gap-5", compact ? "px-3 py-4" : "max-w-3xl px-6 py-8")}>
          {!messages.length && (
            <div className={cn("space-y-5", !compact && "pt-[8vh]")}>
              <div className={cn("flex gap-2.5", !compact && "flex-col items-center text-center")}>
                <BotAvatar className={compact ? "size-6 text-[10px]" : "size-11 text-sm"} />
                <div className="space-y-1">
                  {!compact && <h2 className="text-xl font-semibold">Консультант МТС EnergyTool</h2>}
                  <p className={cn("text-muted-foreground", compact ? "rounded-2xl rounded-tl-md bg-muted px-3 py-2 text-sm text-foreground" : "text-sm")}>
                    {greeting ??
                      "Помогу подобрать решение: учёт электроэнергии, поиск потерь, солнечная генерация, оптовый рынок и тарифы. Опишите задачу своими словами."}
                  </p>
                </div>
              </div>
              <Starters onPick={send} compact={compact} />
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
              onDebug={onSelect && m.role === "assistant" ? () => onSelect(m.id) : undefined}
              onRegenerate={m.role === "assistant" && !chat.busy ? () => {
                const id = chat.regenerate(m.id);
                if (id) onSelect?.(id);
              } : undefined}
              onRate={m.role === "assistant" && m.answer ? (r) => rate(m.id, r) : undefined}
            />
          ))}
          <div ref={bottom} />
        </div>
      </div>
      <div className={cn("shrink-0", compact ? "border-t px-3 pt-2 pb-3" : "mx-auto w-full max-w-3xl px-6 pb-5")}>
        {onLead && hasAnswers && (
          <div className="mb-2 flex justify-center">
            <Button variant="outline" size="sm" onClick={onLead} className="rounded-full">
              <UserRound /> {chat.active?.lead ? `Заявка №${chat.active.lead.id} передана` : "Передать запрос менеджеру"}
            </Button>
          </div>
        )}
        <Composer
          onSend={send}
          onStop={chat.stop}
          busy={chat.busy}
          compact={compact}
          disabled={disabled}
          value={prefill}
          autoFocus={!compact}
        />
        {!compact && (
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            Ответы строятся только по базе знаний МТС EnergyTool. Цифры по вашему объекту подтвердит специалист.
          </p>
        )}
      </div>
    </div>
  );
}
