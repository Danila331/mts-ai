"use client";

import { cn } from "@/lib/utils";

/**
 * Кнопки быстрых ответов (T31) под вопросом бота. Нажатие отправляет текст кнопки репликой клиента; поле ввода
 * не блокируется — клиент вправе ответить своими словами, тогда кнопки исчезают (ими занимается ChatView).
 */
export function QuickReplies({
  items,
  onPick,
  compact,
}: {
  items: string[];
  onPick: (text: string) => void;
  compact?: boolean;
}) {
  if (!items.length) return null;
  return (
    <ul
      aria-label="Быстрые ответы"
      className={cn("msg-in flex flex-wrap gap-1.5", compact ? "pl-8.5" : "pl-9")}
    >
      {items.map((text) => (
        <li key={text}>
          <button
            type="button"
            onClick={() => onPick(text)}
            className="inline-flex min-h-8 items-center rounded-full border border-border/80 bg-background px-3.5 py-1 text-left text-[13px] leading-snug transition-colors hover:border-input hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {text}
          </button>
        </li>
      ))}
    </ul>
  );
}
