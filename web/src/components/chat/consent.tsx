"use client";

import { cn } from "@/lib/utils";

/**
 * Согласие на обработку персональных данных — на том же шаге, что и контакты (раздел базы «Согласие на
 * обработку персональных данных»). Без отметки заявку отправить нельзя: это проверяют и форма, и API.
 */
export function Consent({
  id,
  checked,
  onChange,
  className,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <label htmlFor={id} className={cn("flex cursor-pointer items-start gap-2.5 text-[13px] leading-snug", className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 cursor-pointer rounded accent-[var(--brand)]"
      />
      <span>
        Согласен на обработку персональных данных, чтобы менеджер МТС связался со мной по этой заявке.{" "}
        <span className="text-muted-foreground">Демо-стенд: вводите только тестовые данные.</span>
      </span>
    </label>
  );
}
