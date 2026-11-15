"use client";

import { ArrowUp, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDictation } from "@/hooks/use-dictation";
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

  // Распознанная фраза дописывается в поле для проверки — сама не отправляется.
  const append = useCallback((spoken: string) => {
    setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")} ${spoken}` : spoken));
    ref.current?.focus();
  }, []);
  const dictation = useDictation(append, (message) => toast.error(message));

  const ready = !busy && !disabled && !!text.trim();
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
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <Square className="size-3 fill-current" />
    </button>
  ) : (
    <button
      type="button"
      onClick={submit}
      disabled={!ready}
      aria-label="Отправить"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:ring-3 focus-visible:ring-brand/30 focus-visible:outline-none",
        ready ? "bg-brand text-white hover:bg-primary" : "cursor-default bg-muted text-muted-foreground/70 dark:bg-accent",
      )}
    >
      <ArrowUp className="size-[18px]" strokeWidth={2.4} />
    </button>
  );

  // Без Web Speech API в браузере кнопки нет вовсе.
  const mic = dictation.supported ? (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        dictation.toggle();
      }}
      disabled={disabled}
      aria-pressed={dictation.listening}
      aria-label={dictation.listening ? "Остановить диктовку" : "Надиктовать сообщение"}
      title={dictation.listening ? "Слушаю — нажмите, чтобы закончить" : "Надиктовать: текст появится в поле, отправите сами"}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50",
        dictation.listening
          ? "bg-brand-soft text-brand-text motion-safe:animate-pulse"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Mic className="size-[18px]" />
    </button>
  ) : null;

  return (
    <div
      onClick={() => ref.current?.focus()}
      className={cn(
        "cursor-text border border-input/80 bg-background shadow-[var(--shadow-float)] transition-[border-color,box-shadow] focus-within:border-ring/70 dark:bg-card",
        compact ? "flex items-end gap-2 rounded-[22px] py-1.5 pr-1.5 pl-4" : "rounded-[26px] p-2",
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
          compact ? "min-h-9 flex-1 py-[7px] text-[14px]" : "min-h-12 px-3 pt-1.5 text-[15px]",
        )}
      />
      {compact ? (
        <>
          {mic}
          {action}
        </>
      ) : (
        <div className="flex items-center gap-2 pl-3">
          <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">
            {dictation.listening ? "Слушаю… текст появится в поле, отправите сами" : "Enter — отправить, Shift + Enter — новая строка"}
          </span>
          <span className="flex-1 sm:hidden" />
          {mic}
          {action}
        </div>
      )}
    </div>
  );
}
