"use client";

import { useMemo } from "react";
import {
  CALLBACK_HINT,
  CALLBACK_QUESTION,
  CALLBACK_TIMES,
  type CallbackPreference,
  timezoneOptions,
} from "@/lib/callback";
import { cn } from "@/lib/utils";

/**
 * «Когда удобнее звонок»: часть дня и часовой пояс (T4). Необязательно. Это пожелание для менеджера, а не запись
 * на время — база запрещает обещать точное время звонка. Повторный клик по выбранному варианту снимает выбор.
 */
export function CallbackPicker({
  id,
  value,
  onChange,
  className,
}: {
  id: string;
  value: CallbackPreference;
  onChange: (v: CallbackPreference) => void;
  className?: string;
}) {
  const zones = useMemo(() => timezoneOptions(value.timezone), [value.timezone]);
  return (
    <fieldset className={cn("grid gap-2", className)} aria-describedby={`${id}-hint`}>
      <legend className="mb-1.5 text-[12.5px] text-muted-foreground">
        {CALLBACK_QUESTION} <span className="text-muted-foreground/80">· необязательно</span>
      </legend>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={CALLBACK_QUESTION}>
        {CALLBACK_TIMES.map((t) => {
          const checked = value.time === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => onChange({ ...value, time: checked ? "" : t.value })}
              className={cn(
                "inline-flex h-8 items-center rounded-full border px-3.5 text-[13px] transition-colors",
                checked
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-foreground hover:bg-muted",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-tz`} className="shrink-0 text-[12.5px] text-muted-foreground">
          Часовой пояс
        </label>
        <select
          id={`${id}-tz`}
          value={value.timezone}
          onChange={(e) => onChange({ ...value, timezone: e.target.value })}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-[13px]"
        >
          {zones.map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </select>
      </div>
      <p id={`${id}-hint`} className="text-[12px] leading-snug text-muted-foreground">
        {CALLBACK_HINT}
      </p>
    </fieldset>
  );
}
