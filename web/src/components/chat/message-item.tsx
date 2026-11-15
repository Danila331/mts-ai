"use client";

import { AlertCircle, Check, Copy, PanelRight, RotateCcw, ShieldCheck, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { KbIndex } from "@/hooks/use-kb";
import { tidyStream } from "@/lib/stream-text";
import type { Message } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/brand";
import { AnswerText, SourcesRow } from "./answer-text";
import { DegradedSections } from "./degraded-sections";
import { HonestNoNotice } from "./honest-no";
import { ThinkingLine } from "./thinking-line";

export function BotAvatar({ className }: { className?: string }) {
  return <BrandMark round className={className} />;
}

function IconAction({
  label,
  onClick,
  children,
  active,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            aria-pressed={active}
            className={cn(
              "flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-4",
              active && "text-foreground",
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Tag({ tone, children }: { tone: "warning" | "danger" | "neutral"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-medium",
        tone === "warning" && "bg-tone-warning text-white",
        tone === "danger" && "bg-tone-danger text-white",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** Ответ, который печатается по мере генерации (T13): тот же шрифт, что у готового, и мигающая каретка. */
function StreamingText({ text, compact }: { text: string; compact?: boolean }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-1">
      <p className={cn("text-foreground", compact ? "text-[14px] leading-[1.6]" : "text-[15px] leading-[1.7]")}>
        {tidyStream(text)}
        <span aria-hidden className="stream-caret" />
      </p>
    </div>
  );
}

/** Метка у ответа, который проверка по базе поправила уже после того, как он напечатался. */
function RevisedTag() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3"
          />
        }
      >
        <ShieldCheck aria-hidden />
        Уточнено проверкой
      </TooltipTrigger>
      <TooltipContent>Пока ответ печатался, проверка по базе знаний поправила его — показан проверенный текст</TooltipContent>
    </Tooltip>
  );
}

export function MessageItem({
  message,
  kb,
  onOpenChunk,
  onRegenerate,
  onRate,
  onDebug,
  onLead,
  selected,
  compact,
}: {
  message: Message;
  kb: KbIndex | null;
  onOpenChunk: (chunkId: string) => void;
  onRegenerate?: () => void;
  onRate?: (rating: 1 | -1) => void;
  onDebug?: () => void;
  /** Открыть форму заявки — кнопка в блоке «вот что есть в материалах» (T30). */
  onLead?: () => void;
  selected?: boolean;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  // Анимация только у новых сообщений: история при открытии чата появляется сразу.
  const [fresh] = useState(() => Date.now() - message.createdAt < 4000);
  // Ответ, который мы ждали на глазах у человека, проявляется на месте строки «думает».
  const [waited] = useState(() => !!message.pending);

  if (message.role === "user") {
    return (
      <div className={cn("flex justify-end", fresh && "msg-in")}>
        <div
          className={cn(
            "max-w-[min(85%,36rem)] rounded-3xl bg-muted px-4 py-2.5 leading-relaxed text-foreground dark:bg-accent",
            compact ? "text-[14px]" : "text-[15px]",
          )}
        >
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  const a = message.answer;
  const guardFired = a && (a.guard.unknown_numbers?.length || a.guard.too_long || a.guard.stripped || a.guard.dropped);
  const copy = () => {
    void navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      className={cn(
        "group relative",
        fresh && "msg-in",
        onDebug && "-mx-3 rounded-2xl px-3 py-2 transition-colors",
        onDebug && !message.pending && "hover:bg-surface",
      )}
      onClick={(e) => {
        if (!onDebug || (e.target as HTMLElement).closest("button,a")) return;
        if (window.getSelection()?.toString()) return;
        onDebug();
      }}
    >
      {message.pending && message.streamed ? (
        <StreamingText text={message.streamed} compact={compact} />
      ) : message.pending ? (
        <ThinkingLine message={message} compact={compact} />
      ) : message.error ? (
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="flex items-center gap-1.5 text-destructive">
            <AlertCircle className="size-4" />
            {message.error}
          </span>
          {onRegenerate && (
            <button
              type="button"
              onClick={onRegenerate}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] text-foreground transition-colors hover:bg-muted"
            >
              <RotateCcw className="size-3.5" /> Повторить
            </button>
          )}
        </div>
      ) : (
        // Напечатанный ответ не проявляется заново; заменённый проверкой — проявляется, чтобы замену было видно.
        <div className={cn(waited && (!message.typed || message.revised) && "answer-in")}>
          <AnswerText
            answer={a}
            text={message.content}
            kb={kb}
            onOpenChunk={onOpenChunk}
            showCitations={!compact}
            className={cn("text-foreground", compact ? "text-[14px] leading-[1.6]" : "text-[15px] leading-[1.7]")}
          />
          {/* Модель недоступна (T30): разделы базы вместо ответа и кнопка заявки — заявка работает без модели. */}
          <DegradedSections answer={a} onOpenChunk={onOpenChunk} onLead={onLead} compact={compact} />
          {/* «Честно: не подойдёт» (T26) — и на стенде, и в виджете: это ответ клиенту, а не отладка. */}
          <HonestNoNotice answer={a} onOpenChunk={onOpenChunk} compact={compact} />
          {/* Клиенту в виджете — чистый текст; номера и источники нужны жюри на стенде. */}
          {!compact && <SourcesRow answer={a} kb={kb} onOpen={onOpenChunk} />}
          <div
            className={cn(
              "mt-2 -ml-2 flex flex-wrap items-center gap-0.5 transition-opacity",
              !selected && "opacity-70 group-hover:opacity-100 focus-within:opacity-100",
            )}
          >
            <IconAction label={copied ? "Скопировано" : "Копировать"} onClick={copy}>
              {copied ? <Check /> : <Copy />}
            </IconAction>
            {onRegenerate && (
              <IconAction label="Ответить заново" onClick={onRegenerate}>
                <RotateCcw />
              </IconAction>
            )}
            {onRate && (
              <>
                <IconAction label="Хороший ответ" onClick={() => onRate(1)} active={message.rating === 1}>
                  <ThumbsUp className={cn(message.rating === 1 && "fill-current")} />
                </IconAction>
                <IconAction label="Плохой ответ" onClick={() => onRate(-1)} active={message.rating === -1}>
                  <ThumbsDown className={cn(message.rating === -1 && "fill-current")} />
                </IconAction>
              </>
            )}
            {onDebug && (
              <IconAction label={selected ? "Открыто в отладке" : "Показать в отладке"} onClick={onDebug} active={selected}>
                <PanelRight className={cn(selected && "text-brand-text")} />
              </IconAction>
            )}
            {message.revised && (
              <span className="ml-2 flex items-center">
                <RevisedTag />
              </span>
            )}
            {!compact && a && (
              <span className="ml-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="tnum">{(a.timings.server_total / 1000).toFixed(1).replace(".", ",")} с</span>
                {a.fallback && <Tag tone="warning">запасной ответ</Tag>}
                {guardFired ? <Tag tone="danger">сработала проверка</Tag> : null}
                {a.mode === "eval" && <Tag tone="neutral">автопроверка</Tag>}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
