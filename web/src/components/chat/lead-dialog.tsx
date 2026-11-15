"use client";

import { Check, Loader2, MessagesSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toTurns } from "@/hooks/use-chat";
import { sendLead } from "@/lib/api";
import {
  browserTimezone,
  CALLBACK_PLAIN,
  type CallbackPreference,
  callbackNote,
  guessTime,
  LEAD_SAVED_TITLE,
  leadSavedText,
} from "@/lib/callback";
import { type LeadKind, kindInfo, sessionKinds } from "@/lib/lead-kinds";
import type { Session } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CallbackPicker } from "./callback-picker";
import { LeadKindPicker } from "./lead-kind-picker";
import { Consent } from "./consent";
import { LeadChecklist } from "./post-lead";

function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function Field({
  id,
  label,
  required,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-2", className)}>
      <Label htmlFor={id} className="text-[13px]">
        {label}
        {required ? (
          <span className="text-brand-text" aria-hidden>
            *
          </span>
        ) : (
          <span className="font-normal text-muted-foreground">необязательно</span>
        )}
      </Label>
      {children}
      {error && (
        <p id={`${id}-error`} className="-mt-0.5 text-[12.5px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Резюме от модели приходит строками «Задача клиента: …» — показываем их парами «поле — значение». */
function Summary({ text }: { text: string }) {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean);
  const rows = lines.map((l) => l.match(/^([^:]{2,40}):\s+(.+)$/));
  if (!rows.length || rows.some((r) => !r)) {
    return <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{text}</p>;
  }
  return (
    <dl className="divide-y">
      {rows.map((r, i) => (
        <div key={i} className="py-2.5 first:pt-0 last:pb-0">
          <dt className="text-xs font-medium text-muted-foreground">{r![1]}</dt>
          <dd className="mt-0.5 text-[14px] leading-snug">{r![2]}</dd>
        </div>
      ))}
    </dl>
  );
}

type Slot = React.ElementType<{ className?: string; children?: React.ReactNode }>;

/**
 * Передача диалога менеджеру: контакты + LLM-резюме диалога (как «handoff» в Intercom Fin / Zendesk).
 * На стенде — диалог, в виджете — отдельный экран внутри окна (модалка в модалке в 400px не помещается).
 */
function LeadForm({
  session,
  onDone,
  Title,
  Description,
  closeButton,
  panel,
}: {
  session: Session;
  onDone: (lead: { id: string; summary: string }) => void;
  Title: Slot;
  Description: Slot;
  closeButton: (label: string, primary?: boolean) => React.ReactNode;
  panel?: boolean;
}) {
  const fromPassport = (key: string) => session.passport?.fields.find((f) => f.key === key)?.value ?? "";
  const [form, setForm] = useState(() => ({
    name: fromPassport("name"),
    phone: fromPassport("phone"),
    company: fromPassport("company"),
    comment: "",
  }));
  // Удобное время (T4) — пожелание, а не запись на время.
  const [callback, setCallback] = useState<CallbackPreference>(() => ({
    time: guessTime(fromPassport("callback_preference")),
    timezone: browserTimezone(),
  }));
  // Текст после отправки зависит от того, выбрал ли клиент время, — запоминаем выбор на момент отправки.
  const [savedNote, setSavedNote] = useState(CALLBACK_PLAIN);
  // Тип заявки (T17): только подходящие продуктам из паспорта; предвыбор — по словам клиента.
  // Паспорт может обновиться, пока карточка открыта, — список считается заново, а выбор клиента остаётся,
  // если тип всё ещё подходит.
  const { kinds, guess } = useMemo(() => sessionKinds(session), [session]);
  const [picked, setKind] = useState<LeadKind | null>(null);
  const kind = picked && kinds.some((k) => k.kind === picked) ? picked : guess;
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState({ name: false, phone: false });
  const [sending, setSending] = useState(false);
  const lead = session.lead;
  const digits = form.phone.replace(/\D/g, "").length;
  const nameError = touched.name && !form.name.trim() ? "Как к вам обращаться?" : "";
  const phoneError = touched.phone && digits < 10 ? "Нужен номер из 10–11 цифр, например +7 900 000-00-00" : "";
  const valid = form.name.trim() && digits >= 10 && consent;
  const turns = session.messages.filter((m) => !m.pending && !m.error && m.content).length;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setTouched({ name: true, phone: true });
    if (!valid || sending) return;
    setSending(true);
    try {
      const res = await sendLead({ ...form, messages: toTurns(session.messages), session_id: session.id, callback, kind, consent });
      setSavedNote([kindInfo(kind).note, callbackNote(callback)].filter(Boolean).join(" "));
      onDone(res);
      toast.success(leadSavedText(callback, kindInfo(kind).note), { description: `Номер заявки №${res.id}` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось отправить заявку. Попробуйте ещё раз.");
    } finally {
      setSending(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const blur = (k: keyof typeof touched) => () => setTouched((t) => ({ ...t, [k]: true }));

  const body = panel ? "min-h-0 flex-1 overflow-y-auto px-5 pt-5 pb-6" : "";
  const footer = panel
    ? "shrink-0 space-y-2 border-t bg-background px-5 pt-3 pb-4"
    : "flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end";

  if (lead) {
    return (
      <div className={cn(panel ? "flex h-full min-h-0 flex-col" : "grid gap-6")}>
        <div className={cn(body, "grid grid-cols-[minmax(0,1fr)] content-start gap-5")}>
          <div className="grid gap-1.5 pr-8">
            <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-tone-success text-white">
              <Check className="size-5" strokeWidth={2.5} />
            </span>
            <Title className="font-heading text-[19px] leading-snug font-semibold tracking-[-0.015em]">
              {LEAD_SAVED_TITLE}
            </Title>
            <Description className="text-[14px] leading-relaxed text-muted-foreground">
              {savedNote} Он уже будет знать контекст разговора. Консультация продолжается — вернитесь к чату и
              задавайте вопросы. Номер заявки{" "}
              <span className="font-mono text-[13px] text-foreground">№{lead.id}</span>
            </Description>
          </div>
          <LeadChecklist session={session} className="rounded-xl border bg-surface p-4" />
          <div className="rounded-xl border bg-surface p-4">
            <div className="mb-3 text-[13px] font-semibold">Что получит менеджер</div>
            <Summary text={lead.summary} />
          </div>
        </div>
        <div className={footer}>{closeButton(panel ? "Вернуться к чату" : "Готово", true)}</div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={cn(panel ? "flex h-full min-h-0 flex-col" : "grid gap-6")} noValidate>
      <div className={cn(body, "grid grid-cols-[minmax(0,1fr)] content-start gap-6")}>
        <div className={cn("grid gap-1.5", !panel && "pr-8")}>
          <Title className={cn("font-heading text-[19px] leading-snug font-semibold tracking-[-0.015em]", panel && "sr-only")}>
            Передать запрос менеджеру
          </Title>
          <Description className="text-[14px] leading-relaxed text-muted-foreground">
            {panel
              ? "Оставьте контакты — менеджер перезвонит и уже будет знать, о чём вы говорили с консультантом."
              : "Менеджер МТС EnergyTool получит резюме разговора и перезвонит — повторять задачу не придётся."}
          </Description>
        </div>

        <div className="flex items-center gap-3 rounded-xl bg-surface px-3.5 py-3 ring-1 ring-border">
          <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-[13px] leading-snug">
            <div className="truncate font-medium">{session.title}</div>
            <div className="text-muted-foreground">
              {turns} {plural(turns, "сообщение", "сообщения", "сообщений")} · резюме соберёт ИИ
            </div>
          </div>
        </div>

        <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-4", !panel && "sm:grid-cols-2")}>
          <Field id="lead-name" label="Имя" required error={nameError}>
            <Input
              id="lead-name"
              value={form.name}
              onChange={set("name")}
              onBlur={blur("name")}
              placeholder="Иван Петров"
              autoComplete="off"
              aria-invalid={!!nameError}
              aria-describedby={nameError ? "lead-name-error" : undefined}
            />
          </Field>
          <Field id="lead-phone" label="Телефон" required error={phoneError}>
            <Input
              id="lead-phone"
              value={form.phone}
              onChange={set("phone")}
              onBlur={blur("phone")}
              placeholder="+7 900 000-00-00"
              inputMode="tel"
              autoComplete="off"
              aria-invalid={!!phoneError}
              aria-describedby={phoneError ? "lead-phone-error" : undefined}
            />
          </Field>
          <Field id="lead-company" label="Компания" className={cn(!panel && "sm:col-span-2")}>
            <Input
              id="lead-company"
              value={form.company}
              onChange={set("company")}
              placeholder="ООО «Ромашка»"
              autoComplete="off"
            />
          </Field>
          <Field id="lead-comment" label="Комментарий" className={cn(!panel && "sm:col-span-2")}>
            <Textarea
              id="lead-comment"
              value={form.comment}
              onChange={set("comment")}
              rows={3}
              placeholder="Адрес объекта, что важно знать менеджеру"
              className="field-sizing-fixed min-h-[84px] w-full resize-none"
            />
          </Field>
        </div>
        <LeadKindPicker id={`lead-kind-${session.id}`} kinds={kinds} value={kind} onChange={setKind} />
        <CallbackPicker id={`lead-callback-${session.id}`} value={callback} onChange={setCallback} />
        <Consent id={`lead-consent-${session.id}`} checked={consent} onChange={setConsent} />
      </div>

      <div className={footer}>
        {panel ? (
          <>
            <Button type="submit" size="lg" disabled={sending || !consent} className="h-11 w-full text-[15px]">
              {sending && <Loader2 className="animate-spin" />}
              {sending ? "Отправляю" : "Отправить заявку"}
            </Button>
          </>
        ) : (
          <>
            {closeButton("Отмена")}
            <Button type="submit" size="lg" disabled={sending || !consent}>
              {sending && <Loader2 className="animate-spin" />}
              {sending ? "Отправляю" : "Отправить заявку"}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

export function LeadDialog({
  session,
  open,
  onOpenChange,
  onDone,
}: {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (lead: { id: string; summary: string }) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <LeadForm
          session={session}
          onDone={onDone}
          Title={DialogTitle as Slot}
          Description={DialogDescription as Slot}
          closeButton={(label, primary) => (
            <DialogClose
              render={<Button type="button" variant={primary ? "default" : "ghost"} size="lg" className={cn(primary && "min-w-28")} />}
            >
              {label}
            </DialogClose>
          )}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Экран заявки внутри окна виджета: занимает всё окно под шапкой. */
export function LeadPanel({
  session,
  onDone,
  onClose,
}: {
  session: Session;
  onDone: (lead: { id: string; summary: string }) => void;
  onClose: () => void;
}) {
  return (
    <LeadForm
      panel
      session={session}
      onDone={onDone}
      Title="h2"
      Description="p"
      closeButton={(label) => (
        <Button type="button" size="lg" className="h-11 w-full text-[15px]" onClick={onClose}>
          {label}
        </Button>
      )}
    />
  );
}
