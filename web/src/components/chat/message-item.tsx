"use client";

import {
  AlertTriangle,
  Bug,
  Check,
  Copy,
  RotateCcw,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { KbIndex } from "@/hooks/use-kb";
import type { Message } from "@/lib/types";
import { cn } from "@/lib/utils";
import { AnswerText } from "./answer-text";

export function BotAvatar({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-white",
        className,
      )}
      aria-hidden
    >
      ET
    </div>
  );
}

function IconAction({ label, onClick, children, active }: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClick}
            aria-label={label}
            className={cn("text-muted-foreground", active && "bg-muted text-foreground")}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Pending({ message }: { message: Message }) {
  const found = message.retrieval?.hits.filter((h) => h.in_context).length;
  const label =
    message.stage === "generation"
      ? `Нашёл ${found ?? "нужные"} разделов в базе · формулирую ответ…`
      : message.stage === "retrieval"
        ? `Нашёл ${found} разделов в базе знаний…`
        : "Ищу в базе знаний…";
  return (
    <div className="space-y-2 py-1">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="relative flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand/60" />
          <span className="relative inline-flex size-2 rounded-full bg-brand" />
        </span>
        {label}
      </div>
      <Skeleton className="h-3 w-64" />
      <Skeleton className="h-3 w-48" />
    </div>
  );
}

export function MessageItem({
  message,
  kb,
  onOpenChunk,
  onRegenerate,
  onRate,
  onDebug,
  selected,
  compact,
}: {
  message: Message;
  kb: KbIndex | null;
  onOpenChunk: (chunkId: string) => void;
  onRegenerate?: () => void;
  onRate?: (rating: 1 | -1) => void;
  onDebug?: () => void;
  selected?: boolean;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            "max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-primary-foreground",
            compact ? "text-sm" : "text-[15px]",
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
        "group flex gap-2.5 rounded-xl transition-colors",
        onDebug && "-mx-2 cursor-pointer px-2 py-1.5 hover:bg-muted/50",
        selected && "bg-muted/70 hover:bg-muted/70",
      )}
      onClick={(e) => {
        if (!onDebug || (e.target as HTMLElement).closest("button,a")) return;
        onDebug();
      }}
    >
      <BotAvatar className={compact ? "size-6 text-[10px]" : undefined} />
      <div className="min-w-0 flex-1">
        {message.pending ? (
          <Pending message={message} />
        ) : message.error ? (
          <div className="flex items-center gap-2 py-1 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {message.error}
            {onRegenerate && (
              <Button variant="outline" size="xs" onClick={onRegenerate}>
                <RotateCcw /> Повторить
              </Button>
            )}
          </div>
        ) : (
          <>
            <AnswerText
              answer={a}
              text={message.content}
              kb={kb}
              onOpenChunk={onOpenChunk}
              className={cn("leading-relaxed", compact ? "text-sm" : "text-[15px]")}
            />
            <div
              className={cn(
                "mt-1.5 flex flex-wrap items-center gap-0.5",
                !selected && "opacity-70 transition-opacity group-hover:opacity-100",
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
                    <ThumbsUp />
                  </IconAction>
                  <IconAction label="Плохой ответ" onClick={() => onRate(-1)} active={message.rating === -1}>
                    <ThumbsDown />
                  </IconAction>
                </>
              )}
              {onDebug && (
                <IconAction label="Показать отладку" onClick={onDebug} active={selected}>
                  <Bug />
                </IconAction>
              )}
              {!compact && a && (
                <span className="ml-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  {(a.timings.server_total / 1000).toFixed(1)} c
                  {a.fallback && (
                    <Badge variant="outline" className="h-4 border-amber-300 px-1 text-[10px] text-amber-700">
                      запасной ответ
                    </Badge>
                  )}
                  {guardFired ? (
                    <Badge variant="outline" className="h-4 gap-0.5 border-red-300 px-1 text-[10px] text-red-700">
                      <ShieldAlert className="size-2.5" /> проверка
                    </Badge>
                  ) : null}
                  {a.mode === "eval" && (
                    <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                      автопроверка
                    </Badge>
                  )}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
