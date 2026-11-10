"use client";

import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  compact,
  placeholder = "Опишите задачу: объект, что хотите посчитать или улучшить…",
  autoFocus,
  value: external,
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  compact?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Подставить текст снаружи (например, вопрос из виджета). */
  value?: { text: string; nonce: number };
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!external) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- подстановка текста по внешнему событию
    setText(external.text);
    ref.current?.focus();
  }, [external]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, compact ? 120 : 200)}px`;
  }, [text, compact]);

  const submit = () => {
    if (busy || disabled || !text.trim()) return;
    onSend(text);
    setText("");
  };

  return (
    <div
      className={cn(
        "flex items-end gap-2 rounded-2xl border bg-background p-2 shadow-sm transition focus-within:border-foreground/30 focus-within:shadow-md",
        compact && "rounded-xl",
      )}
    >
      <textarea
        ref={ref}
        value={text}
        rows={1}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        aria-label="Сообщение консультанту"
        className={cn(
          "max-h-52 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 outline-none placeholder:text-muted-foreground",
          compact ? "text-sm" : "text-[15px]",
        )}
      />
      {busy ? (
        <Button size="icon" variant="secondary" onClick={onStop} aria-label="Остановить" className="rounded-full">
          <Square className="size-3.5 fill-current" />
        </Button>
      ) : (
        <Button
          size="icon"
          onClick={submit}
          disabled={disabled || !text.trim()}
          aria-label="Отправить"
          className="rounded-full bg-brand text-white hover:bg-brand/85"
        >
          <ArrowUp />
        </Button>
      )}
    </div>
  );
}
