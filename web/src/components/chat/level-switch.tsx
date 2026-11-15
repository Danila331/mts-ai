"use client";

import { LEVELS, LEVEL_IDS, type LevelId } from "@/lib/level";
import { cn } from "@/lib/utils";

/**
 * Переключатель уровня объяснения (T16): «Обычно / Проще / Технически». Меняет только форму следующих ответов —
 * факты те же. Для уже готового ответа есть кнопка «Объяснить проще / технически» под ним.
 */
export function LevelSwitch({
  value,
  onPick,
  compact,
  disabled,
  className,
}: {
  value?: LevelId | "";
  onPick: (level: LevelId | "") => void;
  compact?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const current = value ?? "";
  const options: { id: LevelId | ""; label: string; hint?: string }[] = [
    { id: "", label: "Обычно" },
    ...LEVEL_IDS.map((id) => ({ id, label: LEVELS[id].label, hint: LEVELS[id].hint })),
  ];
  return (
    <div className={cn("flex items-center gap-2", !compact && "justify-center", className)}>
      {!compact && <span className="text-xs text-muted-foreground">Как объяснять</span>}
      <div
        role="radiogroup"
        aria-label="Уровень объяснения"
        className="inline-flex rounded-full border border-border/80 bg-background p-0.5 dark:bg-transparent"
      >
        {options.map((o) => {
          const on = current === o.id;
          return (
            <button
              key={o.id || "default"}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              title={o.hint}
              onClick={() => onPick(o.id)}
              className={cn(
                "inline-flex h-6 items-center rounded-full px-2.5 text-[12.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
                on ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
