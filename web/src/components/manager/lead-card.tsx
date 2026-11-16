"use client";

import { ArrowLeft, Copy, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GradeBadge, KindBadge, StatusBadge } from "@/components/manager/badges";
import { ManagerProblem } from "@/components/manager/manager-chrome";
import { Block, Row, TurnList } from "@/components/manager/dialog-parts";
import { MeetingBrief } from "@/components/manager/meeting-brief";
import { Button } from "@/components/ui/button";
import { useKb } from "@/hooks/use-kb";
import {
  callbackWish,
  type LeadCard,
  type LeadStatus,
  ManagerError,
  STATUS_LABEL,
  formatPhone,
  getLead,
  filledFields,
  leadTitle,
  pickTranscript,
  setLeadStatus,
  waiting,
} from "@/lib/manager";
import { humanizeCallbackLabel } from "@/lib/callback";

const STATUSES: LeadStatus[] = ["new", "in_progress", "done", "rejected"];

/** Карточка заявки (T5): контакты, тип и удобное время, резюме, паспорт, оценка, переписка с источниками, статус. */
export function LeadCardView({
  code,
  onBack,
  onStatus,
}: {
  code: string;
  onBack: () => void;
  onStatus: (code: string, status: LeadStatus, label: string) => void;
}) {
  const [card, setCard] = useState<LeadCard | null>(null);
  const [error, setError] = useState<ManagerError | null>(null);
  const [saving, setSaving] = useState<LeadStatus | null>(null);
  const { kb } = useKb();

  useEffect(() => {
    const ctrl = new AbortController();
    getLead(code, ctrl.signal)
      .then(setCard)
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(e instanceof ManagerError ? e : new ManagerError("Не удалось загрузить заявку"));
      });
    return () => ctrl.abort();
  }, [code]);

  const change = async (status: LeadStatus) => {
    if (!card || status === card.status) return;
    setSaving(status);
    try {
      const done = await setLeadStatus(card.code, status);
      setCard({ ...card, status: done.status, status_label: done.status_label });
      onStatus(card.code, done.status, done.status_label);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Не удалось сменить статус");
    } finally {
      setSaving(null);
    }
  };

  if (error) return <ManagerProblem message={error.message} setup={error.setup} />;
  if (!card) {
    return (
      <p className="flex items-center gap-2 p-8 text-[14px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Загружаю заявку…
      </p>
    );
  }

  // Всё, что клиент рассказал в чате, включая контакты и удобное время; переписка — полная, с сервера.
  const passportFields = filledFields(card.passport);
  const turns = pickTranscript(card.history, card.messages, card.created_at);

  return (
    <article className="pb-10">
      <header className="px-5 pt-4 pb-4">
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 lg:hidden" onClick={onBack}>
          <ArrowLeft /> К списку
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.015em]">{leadTitle(card)}</h2>
          <GradeBadge grade={card.grade} label={card.grade_label} />
          <KindBadge label={card.kind_label} />
          <StatusBadge status={card.status} label={card.status_label} />
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">
          <span className="font-mono">№{card.code}</span> · {new Date(card.created_at).toLocaleString("ru-RU")}
          {card.status === "new" && ` · ${waiting(card.created_at)}`} · {card.product_label}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Статус заявки">
          {STATUSES.map((s) => (
            <Button
              key={s}
              size="sm"
              variant={card.status === s ? "default" : "outline"}
              disabled={saving !== null}
              aria-pressed={card.status === s}
              onClick={() => change(s)}
            >
              {saving === s && <Loader2 className="animate-spin" />}
              {STATUS_LABEL[s]}
            </Button>
          ))}
        </div>
      </header>

      <Block title="Контакты и время">
        <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1.5 text-[14px]">
          <Row label="Имя" value={card.name} />
          <Row label="Телефон" value={formatPhone(card.phone)}>
            {card.phone && (
              <button
                type="button"
                aria-label="Скопировать телефон"
                onClick={() => {
                  void navigator.clipboard.writeText(formatPhone(card.phone));
                  toast.success("Телефон скопирован");
                }}
                className="ml-2 inline-flex size-6 items-center justify-center rounded-md align-middle text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <Copy className="size-3.5" aria-hidden />
              </button>
            )}
          </Row>
          <Row label="Компания" value={card.company} />
          <Row label="Тип заявки" value={card.kind_label} />
          <Row label="Удобное время" value={callbackWish(card)} empty="не указано" />
          {card.comment && <Row label="Комментарий" value={card.comment} />}
        </dl>
        <p className="mt-2 text-[12px] text-muted-foreground">
          Удобное время — пожелание клиента, а не договорённость: время звонка заранее не обещаем.
        </p>
      </Block>

      <Block title={card.summary_source === "llm" ? "Резюме для менеджера" : "Резюме (список вопросов клиента, модель не ответила)"}>
        <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{humanizeCallbackLabel(card.summary)}</p>
      </Block>

      <Block title="Паспорт задачи">
        {card.passport.total ? (
          <div className="mb-3 flex items-center gap-3 text-[13px]">
            <div className="h-2 w-40 overflow-hidden rounded-full bg-dim" role="img" aria-label={`Заполнено ${card.passport.filled} из ${card.passport.total}`}>
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.round(((card.passport.filled ?? 0) / card.passport.total) * 100)}%` }}
              />
            </div>
            <span className="tnum">
              {card.passport.filled} из {card.passport.total} полей · {card.passport.product_label}
            </span>
          </div>
        ) : null}
        {passportFields.length > 0 ? (
          <dl className="grid grid-cols-[minmax(130px,200px)_1fr] gap-x-3 gap-y-1.5 text-[14px]">
            {passportFields.map((f) => (
              <Row key={f.key} label={f.label} value={`${f.value}${f.source === "client" ? " (клиент)" : ""}`} />
            ))}
          </dl>
        ) : (
          <p className="text-[14px] text-muted-foreground">Паспорта нет: заявка не из разговора или без сохранённой сессии.</p>
        )}
      </Block>

      <Block title="Оценка заявки">
        <div className="mb-2 flex items-center gap-2">
          <GradeBadge grade={card.score.grade} label={card.grade_label} />
          {card.score.grade && <span className="text-[12px] text-muted-foreground tnum">{card.score.points} баллов</span>}
        </div>
        {card.score.reasons.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-[14px]">
            {card.score.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          <p className="text-[14px] text-muted-foreground">Оценки нет: заявка старше скоринга.</p>
        )}
        {card.score.missing.length > 0 && (
          <div className="mt-3 rounded-lg border p-3">
            <p className="text-[13px] font-semibold">Что спросить на звонке</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[14px]">
              {card.score.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
      </Block>

      <Block title="Шпаргалка к встрече">
        <MeetingBrief card={card} />
      </Block>

      <Block title={card.history ? `Переписка (${card.history.session.channel === "embed" ? "виджет" : "стенд"})` : "Переписка на момент отправки"}>
        {card.session_id && card.history && (
          <p className="mb-2 text-[12px]">
            <Link href={`/manager/dialogs?id=${card.session_id}`} className="text-primary underline underline-offset-2">
              Открыть диалог целиком
            </Link>
          </p>
        )}
        {!card.history && card.session_id && (
          <p className="mb-2 text-[12px] text-muted-foreground">Сессия удалена по сроку хранения — осталась переписка из заявки.</p>
        )}
        {turns.length === 0 ? (
          <p className="text-[14px] text-muted-foreground">Переписки нет.</p>
        ) : (
          <TurnList turns={turns} kb={kb} />
        )}
      </Block>
    </article>
  );
}
