"use client";

import type { LeadKind, LeadKindInfo } from "@/lib/lead-kinds";
import { cn } from "@/lib/utils";

/**
 * Тип заявки (T17): только подходящие продуктам из паспорта. У клиента про солнечную станцию — звонок и
 * предварительная оценка; про платформу учёта — ещё демо-кабинет и пилот.
 */
export function LeadKindPicker({
  id,
  kinds,
  value,
  onChange,
  className,
}: {
  id: string;
  kinds: LeadKindInfo[];
  value: LeadKind;
  onChange: (k: LeadKind) => void;
  className?: string;
}) {
  return (
    <fieldset className={cn("grid gap-1.5", className)}>
      <legend className="mb-1.5 text-[12.5px] text-muted-foreground">Что оформить</legend>
      <div role="radiogroup" aria-label="Тип заявки" className="grid gap-1.5">
        {kinds.map((k) => {
          const checked = k.kind === value;
          return (
            <button
              key={k.kind}
              id={`${id}-${k.kind}`}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => onChange(k.kind)}
              className={cn(
                "flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors",
                checked ? "border-primary bg-surface ring-1 ring-primary" : "bg-background hover:bg-muted",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1 size-3.5 shrink-0 rounded-full border",
                  checked ? "border-[4px] border-primary" : "border-input",
                )}
              />
              <span className="min-w-0">
                <span className="block text-[13.5px] leading-snug font-medium">{k.label}</span>
                <span className="block text-[12px] leading-snug text-muted-foreground">{k.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
