"use client";

import { CheckCircle2, Loader2, UserRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toTurns } from "@/hooks/use-chat";
import { sendLead } from "@/lib/api";
import type { Session } from "@/lib/types";

/** Передача диалога менеджеру: контакты + LLM-резюме диалога (как «handoff» в Intercom Fin / Zendesk). */
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
  const [form, setForm] = useState({ name: "", phone: "", company: "", comment: "" });
  const [sending, setSending] = useState(false);
  const lead = session.lead;
  const valid = form.name.trim() && form.phone.replace(/\D/g, "").length >= 10;

  const submit = async () => {
    setSending(true);
    try {
      const res = await sendLead({ ...form, messages: toTurns(session.messages) });
      onDone(res);
      toast.success("Заявка передана менеджеру");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось отправить заявку");
    } finally {
      setSending(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {lead ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 className="size-5 text-emerald-600" /> Заявка №{lead.id} передана
              </DialogTitle>
              <DialogDescription>Менеджер свяжется с вами и уже будет знать контекст разговора.</DialogDescription>
            </DialogHeader>
            <div className="rounded-lg bg-muted p-3 text-sm">
              <div className="mb-1 text-xs font-medium text-muted-foreground">Резюме для менеджера</div>
              <p className="whitespace-pre-wrap leading-relaxed">{lead.summary}</p>
            </div>
            <DialogFooter showCloseButton />
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UserRound className="size-5 text-brand" /> Передать запрос менеджеру
              </DialogTitle>
              <DialogDescription>
                Менеджер получит резюме диалога — повторять задачу не придётся. Данные — только тестовые.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="lead-name">Имя *</Label>
                <Input id="lead-name" value={form.name} onChange={set("name")} placeholder="Иван Петров" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lead-phone">Телефон *</Label>
                <Input
                  id="lead-phone"
                  value={form.phone}
                  onChange={set("phone")}
                  placeholder="+7 900 000-00-00"
                  inputMode="tel"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lead-company">Компания</Label>
                <Input id="lead-company" value={form.company} onChange={set("company")} placeholder="ООО «Ромашка»" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="lead-comment">Комментарий</Label>
                <Textarea id="lead-comment" value={form.comment} onChange={set("comment")} rows={2} />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={submit}
                disabled={!valid || sending}
                className="bg-brand text-white hover:bg-brand/85"
              >
                {sending && <Loader2 className="animate-spin" />} Отправить заявку
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
