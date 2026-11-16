"use client";

import { Headset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Карточка под ответом, в котором бот сам предложил передать разговор менеджеру (поле answer.handoff).
 * «Передать менеджеру» сразу открывает форму заявки в ленте — без запроса к серверу; согласие на обработку
 * данных стоит в самой форме. «Пока продолжим» закрывает карточку и сообщает об этом боту, чтобы он не повторял предложение.
 */
export function HandoffOffer({
  onAccept,
  onLater,
  compact,
}: {
  onAccept: () => void;
  onLater: () => void;
  compact?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Передать разговор менеджеру"
      className={cn(
        "msg-in flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-2xl border bg-background p-3.5 shadow-[var(--shadow-float)]",
        compact ? "mx-0" : "ml-9",
      )}
    >
      <div className="flex min-w-0 flex-1 basis-56 items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-white">
          <Headset className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] leading-tight font-medium">Передать запрос менеджеру МТС</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Менеджер получит ваш диалог и паспорт задачи.</p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button type="button" size="sm" onClick={onAccept}>
          Передать менеджеру
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onLater}>
          Пока продолжим
        </Button>
      </div>
    </div>
  );
}
