"use client";

import { CheckCircle2, ChevronRight, Headset } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { ChatController } from "@/hooks/use-chat";
import type { KbIndex } from "@/hooks/use-kb";
import { sendFeedback } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type WizardAnswers, type WizardFlow, chatReplica, passportValues } from "@/lib/wizards/engine";
import { WizardEntry, WizardRunner, WizardSummary } from "@/components/wizard/wizard";
import { Composer } from "./composer";
import { BotAvatar, MessageItem } from "./message-item";
import { BrandGlyph } from "@/components/brand";
import { InlineLead } from "./inline-lead";
import { PassportCard } from "./passport-card";
import { type Starter, Starters } from "./starters";

const GREETING =
  "Подберу решение по базе знаний МТС EnergyTool: учёт электроэнергии, поиск потерь, солнечная генерация, оптовый рынок и тарифы. Опишите задачу своими словами.";

function LeadButton({ done, onClick, compact }: { done?: string; onClick: () => void; compact?: boolean }) {
  // В виджете — строка во всю ширину поля ввода: ясная точка входа к живому человеку.
  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-center gap-3 rounded-[18px] border bg-surface px-3 py-2.5 text-left transition-colors hover:border-input hover:bg-muted"
      >
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full",
            done ? "bg-tone-success text-white" : "bg-primary text-white",
          )}
        >
          {done ? <CheckCircle2 className="size-4" /> : <Headset className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] leading-tight font-medium">
            {done ? "Заявка передана менеджеру" : "Передать запрос менеджеру"}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {done ? `№${done} · посмотреть, что получит менеджер` : "Менеджер свяжется и будет знать контекст"}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border bg-background px-3.5 text-[13px] font-medium shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors hover:bg-muted dark:bg-card",
        compact && "h-7 px-3 text-[12.5px]",
      )}
    >
      {done ? (
        <>
          <CheckCircle2 className="size-3.5 text-success" /> Заявка №{done} передана
        </>
      ) : (
        <>
          <Headset className="size-3.5 text-brand-text" /> Передать запрос менеджеру
        </>
      )}
    </button>
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
  heading = "Чем помочь с электроэнергией?",
  starters,
  prefill,
  disabled,
  wizards,
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
  /** Заголовок пустого экрана и подсказки первого вопроса — свои у копилота менеджера. */
  heading?: string;
  starters?: Starter[];
  prefill?: { text: string; nonce: number };
  disabled?: boolean;
  /** Мастера (T7), которые предлагаются в пустом чате. Только клиентский режим chat: им нужен паспорт. */
  wizards?: readonly WizardFlow[];
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
  const session = chat.active;

  // Открытый мастер привязан к диалогу: переключились на другой — мастер не тянется следом.
  const [wizardOpen, setWizardOpen] = useState<{ session: string; flow: string } | null>(null);
  const openFlow = wizardOpen?.session === chat.activeId ? wizards?.find((f) => f.id === wizardOpen.flow) : undefined;
  const record = session?.wizard;
  const recordFlow = record ? wizards?.find((f) => f.id === record.flow) : undefined;
  const startWizard = (flow: WizardFlow) => setWizardOpen({ session: chat.activeId, flow: flow.id });
  // Ответы мастера уходят в чат репликой клиента и в паспорт задачи (как правка клиента) — после ответа бота.
  const finishWizard = (flow: WizardFlow, answers: WizardAnswers, intent: "continue" | "handoff") => {
    chat.setWizard({ flow: flow.id, answers }, passportValues(flow, answers));
    setWizardOpen(null);
    send(chatReplica(flow, answers, intent));
  };

  const passport = session?.passport;
  // Паспорт показываем, когда в нём что-то есть; карточку заявки — когда есть контакты или согласие
  // и заявка ещё не отправлена, и только после ответа (не посреди генерации).
  const hasPassport = !!passport?.fields.some((f) => f.value);
  const showInlineLead = !!session && !!passport?.ready_for_lead && !session.lead && !chat.busy;
  const leadDone = (lead: { id: string; summary: string }) => chat.setLead(lead);
  const composer = (
    <Composer
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

  // Пустой стенд — как в Claude: знак и вопрос одной строкой, поле ввода, тихие подсказки под ним.
  if (!messages.length && !compact && openFlow) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] px-5 pt-8 pb-16 sm:px-6">
          <WizardRunner
            key={`${chat.activeId}-${openFlow.id}`}
            flow={openFlow}
            kb={kb}
            onOpenChunk={onOpenChunk}
            onClose={() => setWizardOpen(null)}
            onFinish={(answers, intent) => finishWizard(openFlow, answers, intent)}
          />
        </div>
      </div>
    );
  }

  if (!messages.length && !compact) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col justify-center px-5 pt-6 pb-[14vh] sm:px-6">
          <div className="msg-in flex flex-col items-center text-center">
            <h1 className="flex items-center gap-3 text-[26px] leading-tight font-medium tracking-[-0.02em] sm:text-[30px]">
              <BrandGlyph className="size-8 sm:size-9" />
              {heading}
            </h1>
            <p className="mt-2.5 max-w-[36rem] text-[14px] leading-relaxed text-pretty text-muted-foreground">
              {greeting ?? "Отвечаю только по базе знаний МТС EnergyTool и показываю источник каждого факта."}
            </p>
          </div>
          <div className="mt-7">{composer}</div>
          <div className="mt-4">
            <Starters onPick={send} items={starters} />
          </div>
          {!!wizards?.length && (
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {wizards.map((flow) => (
                <WizardEntry key={flow.id} flow={flow} onStart={() => startWizard(flow)} />
              ))}
            </div>
          )}
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
            compact ? "gap-5 px-4 pt-4 pb-6" : "max-w-[720px] gap-7 px-5 pt-4 pb-10 sm:px-6",
          )}
        >
          {!messages.length && compact && openFlow && (
            <WizardRunner
              key={`${chat.activeId}-${openFlow.id}`}
              flow={openFlow}
              kb={kb}
              compact
              onOpenChunk={onOpenChunk}
              onClose={() => setWizardOpen(null)}
              onFinish={(answers, intent) => finishWizard(openFlow, answers, intent)}
            />
          )}
          {!messages.length && compact && !openFlow && (
            <div className="space-y-4">
              <div className="flex items-start gap-2.5">
                <BotAvatar className="mt-0.5 size-6" />
                <p className="rounded-2xl rounded-tl-md bg-muted px-3.5 py-2.5 text-[14px] leading-relaxed">
                  {greeting ?? GREETING}
                </p>
              </div>
              <div className="space-y-1.5 pl-8.5">
                {wizards?.map((flow) => (
                  <WizardEntry key={flow.id} flow={flow} onStart={() => startWizard(flow)} compact />
                ))}
                <Starters onPick={send} compact items={starters} />
              </div>
            </div>
          )}
          {hasPassport && passport && (
            <div className={cn("sticky top-0 z-10 -mt-1 bg-background/95 pb-1 backdrop-blur", !compact && "pt-1")}>
              <PassportCard key={session?.id} passport={passport} onEdit={chat.editPassport} compact={compact} />
            </div>
          )}
          {record && recordFlow && messages.length > 0 && (
            <WizardSummary
              key={session?.id}
              flow={recordFlow}
              answers={record.answers}
              kb={kb}
              onOpenChunk={onOpenChunk}
              compact={compact}
            />
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
          {showInlineLead && session && <InlineLead key={session.id} session={session} onDone={leadDone} compact={compact} />}
          <div ref={bottom} />
        </div>
      </div>
      <div className={cn("shrink-0", compact ? "px-3 pt-1 pb-2" : "mx-auto w-full max-w-[720px] px-4 pb-3 sm:px-6")}>
        {onLead && hasAnswers && (
          <div className={cn("flex justify-center", compact ? "mb-2" : "mb-2.5")}>
            <LeadButton done={chat.active?.lead?.id} onClick={onLead} compact={compact} />
          </div>
        )}
        {composer}
        {!compact && (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Ответы строятся только по базе знаний МТС EnergyTool. Цифры по вашему объекту подтвердит специалист.
          </p>
        )}
      </div>
    </div>
  );
}
