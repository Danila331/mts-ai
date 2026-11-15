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
          const inputId = `${id}-${k.kind}`;
          return (
            // Нативные радио: имя, описание и стрелки клавиатуры работают без самодельного ARIA.
            <label
              key={k.kind}
              htmlFor={inputId}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50",
                checked ? "border-primary bg-surface ring-1 ring-primary" : "bg-background hover:bg-muted",
              )}
            >
              <input
                id={inputId}
                type="radio"
                name={`${id}-kind`}
                value={k.kind}
                checked={checked}
                onChange={() => onChange(k.kind)}
                aria-labelledby={`${inputId}-label`}
                aria-describedby={`${inputId}-hint`}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn(
                  "mt-1 size-3.5 shrink-0 rounded-full border",
                  checked ? "border-[4px] border-primary" : "border-input",
                )}
              />
              <span className="min-w-0">
                <span id={`${inputId}-label`} className="block text-[13.5px] leading-snug font-medium">
                  {k.label}
                </span>
                <span id={`${inputId}-hint`} className="block text-[12px] leading-snug text-muted-foreground">
                  {k.hint}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
