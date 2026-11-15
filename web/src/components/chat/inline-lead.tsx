"use client";

import { Check, Loader2, UserRoundCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toTurns } from "@/hooks/use-chat";
import { sendLead } from "@/lib/api";
import type { Session } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Consent } from "./consent";

const value = (s: Session, key: string) => s.passport?.fields.find((f) => f.key === key)?.value ?? "";

/**
 * «Проверьте заявку» прямо в ленте: появляется, когда в паспорте есть контакты или клиент согласился на
 * передачу. Поля предзаполнены тем, что клиент написал в чат, — он их проверяет, ставит согласие и сам
 * нажимает «Отправить». Без клика заявка не создаётся, а бот не говорит, что она отправлена.
 */
export function InlineLead({
  session,
  onDone,
  compact,
}: {
  session: Session;
  onDone: (lead: { id: string; summary: string }) => void;
  compact?: boolean;
}) {
  const [form, setForm] = useState(() => ({
    name: value(session, "name"),
    phone: value(session, "phone"),
    company: value(session, "company"),
    comment: value(session, "callback_preference"),
  }));
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const digits = form.phone.replace(/\D/g, "").length;
  const ready = consent && !!form.name.trim() && digits >= 10 && !sending;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setSending(true);
    try {
      const lead = await sendLead({
        ...form,
        messages: toTurns(session.messages),
        session_id: session.id,
        consent,
      });
      onDone(lead);
      toast.success("Заявка передана менеджеру");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось отправить заявку");
    } finally {
      setSending(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const id = (k: string) => `inline-lead-${session.id}-${k}`;

  return (
    <form
      onSubmit={submit}
      aria-label="Проверьте заявку"
      className={cn("msg-in rounded-2xl border bg-background p-4 shadow-[var(--shadow-float)]", compact ? "mx-0" : "ml-9")}
    >
      <div className="flex items-center gap-2 text-[14px] font-semibold">
        <UserRoundCheck className="size-4 text-brand-text" aria-hidden /> Проверьте заявку
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Заполнили по вашим сообщениям — поправьте, если что-то не так. Менеджер получит и паспорт задачи.
      </p>
      <div className={cn("mt-3 grid gap-2.5", !compact && "sm:grid-cols-2")}>
        {(
          [
            ["name", "Как к вам обращаться", "Тестов Тест Тестович"],
            ["phone", "Телефон", "+7 900 000-00-00"],
            ["company", "Компания", "ООО Учебный склад"],
            ["comment", "Удобное время для звонка", "необязательно"],
          ] as const
        ).map(([k, label, placeholder]) => (
          <div key={k} className="grid gap-1">
            <label htmlFor={id(k)} className="text-[12.5px] text-muted-foreground">
              {label}
            </label>
            <Input
              id={id(k)}
              value={form[k]}
              onChange={set(k)}
              placeholder={placeholder}
              inputMode={k === "phone" ? "tel" : undefined}
              autoComplete={k === "phone" ? "tel" : k === "name" ? "name" : k === "company" ? "organization" : "off"}
            />
          </div>
        ))}
      </div>
      <Consent id={id("consent")} checked={consent} onChange={setConsent} className="mt-3.5" />
      <div className="mt-3.5 flex items-center justify-end gap-2">
        <Button type="submit" disabled={!ready}>
          {sending ? <Loader2 className="animate-spin" /> : <Check />}
          Отправить
        </Button>
      </div>
    </form>
  );
}
