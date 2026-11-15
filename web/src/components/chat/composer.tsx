"use client";

import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  compact,
  placeholder = "Опишите задачу: объект, что хотите посчитать или улучшить",
  autoFocus,
  value: external,
  tools,
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
  /** Действия слева в нижней строке поля (например, «Передать менеджеру»). */
  tools?: React.ReactNode;
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
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, compact ? 128 : 224)}px`;
    };
    fit();
    // В виджете чат грузится заранее в скрытом окне: пересчитываем высоту, когда поле получает настоящую ширину.
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, compact]);

  const ready = !busy && !disabled && !!text.trim();
  // Нижняя строка с инструментами: всегда на стенде, в виджете — когда есть что показать слева.
  const stacked = !compact || !!tools;
  const submit = () => {
    if (!ready) return;
    onSend(text);
    setText("");
  };

  const action = busy ? (
    <button
      type="button"
      onClick={onStop}
      aria-label="Остановить ответ"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Square className="size-2.5 fill-current" />
    </button>
  ) : (
    <button
      type="button"
      onClick={submit}
      disabled={!ready}
      aria-label="Отправить"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-150 focus-visible:ring-3 focus-visible:ring-brand/30 focus-visible:outline-none active:scale-95",
        ready
          ? "bg-brand text-brand-foreground hover:bg-[color-mix(in_oklch,var(--brand),black_10%)]"
          : "cursor-default bg-muted text-muted-foreground/60 dark:bg-accent",
      )}
    >
      <ArrowUp className="size-4" strokeWidth={2.5} />
    </button>
  );

  return (
    <div
      onClick={() => ref.current?.focus()}
      className={cn(
        "cursor-text border border-input bg-background shadow-[var(--shadow-float)] transition-[border-color,box-shadow] focus-within:border-ring dark:bg-card",
        stacked ? "rounded-[20px] p-2" : "flex items-end gap-2 rounded-[20px] py-1.5 pr-1.5 pl-4",
        compact && stacked && "rounded-[16px] p-1.5",
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
          "block w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground",
          stacked
            ? cn("px-2.5 pt-1.5", compact ? "min-h-9 text-[14px]" : "min-h-11 text-[15px]")
            : "min-h-9 flex-1 py-[7px] text-[14px]",
        )}
      />
      {!stacked ? (
        action
      ) : (
        <div className="flex min-h-8 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {tools ?? (
              <span className="hidden truncate pl-2.5 text-[12px] text-muted-foreground sm:block">
                Enter — отправить · Shift + Enter — новая строка
              </span>
            )}
          </div>
          {action}
        </div>
      )}
    </div>
  );
}
