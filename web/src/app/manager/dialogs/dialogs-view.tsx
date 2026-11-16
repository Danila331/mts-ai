"use client";

import { ArrowLeft, Loader2, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell, PageBar } from "@/components/app-shell";
import { Block, Row, TurnList } from "@/components/manager/dialog-parts";
import { DemoBanner, ManagerProblem, ManagerTabs } from "@/components/manager/manager-chrome";
import { DialogLeadBadge, KindBadge } from "@/components/manager/badges";
import { Button } from "@/components/ui/button";
import { useKb } from "@/hooks/use-kb";
import {
  DIALOG_ID,
  type DialogHistory,
  type DialogItem,
  type DialogList,
  ManagerError,
  POLL_MS,
  ago,
  channelLabel,
  dialogRole,
  dialogTitle,
  filledFields,
  getDialog,
  getDialogs,
  latestDialogsFirst,
  messagesLabel,
} from "@/lib/manager";
import { LEAD_KINDS } from "@/lib/lead-kinds";
import { cn } from "@/lib/utils";

/**
 * Вкладка «Диалоги»: все разговоры клиентов с ботом, в том числе без заявки (пункт 5 кейса). Слева список, справа
 * переписка с паспортом и ссылкой на заявку. Список и открытый диалог обновляются раз в 10 секунд.
 */
export function DialogsView() {
  const wanted = useSearchParams().get("id") ?? "";
  const initialId = DIALOG_ID.test(wanted) ? wanted : null;
  const [list, setList] = useState<DialogList | null>(null);
  const [error, setError] = useState<ManagerError | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId);
  const [now, setNow] = useState(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getDialogs(100, signal);
      setList({ ...next, items: latestDialogsFirst(next.items) });
      setError(null);
      setNow(Date.now());
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof ManagerError ? e : new ManagerError("Не удалось загрузить диалоги"));
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    const first = setTimeout(() => void refresh(ctrl.signal), 0);
    const timer = setInterval(() => {
      if (!document.hidden) void refresh(ctrl.signal);
    }, POLL_MS);
    return () => {
      ctrl.abort();
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  return (
    <AppShell>
      <PageBar icon={MessagesSquare} title="Менеджер" subtitle="все диалоги с ботом" />
      <ManagerTabs />
      <DemoBanner />
      {error && !list ? (
        <ManagerProblem message={error.message} setup={error.setup} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(320px,400px)_1fr]">
          <section aria-label="Список диалогов" className={cn("min-h-0 overflow-y-auto border-r", selected && "hidden lg:block")}>
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-2 text-[12px] text-muted-foreground">
              <span>{list ? `Диалогов: ${list.total}` : "Загружаю…"}</span>
              <span>{error ? "нет связи, повторяю…" : "обновляется каждые 10 с"}</span>
            </div>
            {list && list.items.length === 0 && (
              <p className="p-6 text-[14px] text-muted-foreground">
                Диалогов пока нет. Напишите боту на «Чат и отладка» — разговор появится здесь сам, даже без заявки.
              </p>
            )}
            <ul>
              {list?.items.map((d) => (
                <DialogRow key={d.id} dialog={d} now={now} active={d.id === selected} onOpen={setSelected} />
              ))}
            </ul>
          </section>
          <section aria-label="Диалог" className={cn("min-h-0 overflow-y-auto", !selected && "hidden lg:block")}>
            {selected ? (
              <DialogCard key={selected} id={selected} onBack={() => setSelected(null)} />
            ) : (
              <p className="p-8 text-[14px] text-muted-foreground">Выберите диалог слева.</p>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function DialogRow({
  dialog,
  now,
  active,
  onOpen,
}: {
  dialog: DialogItem;
  now: number;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  const role = dialogRole(dialog.role);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(dialog.id)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "block w-full border-b px-4 py-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
          active && "bg-muted",
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[14px] font-medium">{dialogTitle(dialog)}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground" title={new Date(dialog.updated_at).toLocaleString("ru-RU")}>
            {ago(dialog.updated_at, now)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{channelLabel(dialog.channel)}</span>
          <span>{messagesLabel(dialog.messages)}</span>
          {dialog.product_label && dialog.product !== "general" && <span className="truncate">{dialog.product_label}</span>}
          {role && <span className="truncate">{role}</span>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <DialogLeadBadge code={dialog.lead_code} />
        </div>
      </button>
    </li>
  );
}

/** Диалог целиком. Обновляется, пока открыт: клиент ещё может писать. */
function DialogCard({ id, onBack }: { id: string; onBack: () => void }) {
  const [dialog, setDialog] = useState<DialogHistory | null>(null);
  const [error, setError] = useState<ManagerError | null>(null);
  const { kb } = useKb();

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      getDialog(id, ctrl.signal)
        .then((d) => {
          setDialog(d);
          setError(null);
        })
        .catch((e) => {
          if (!ctrl.signal.aborted) setError(e instanceof ManagerError ? e : new ManagerError("Не удалось загрузить диалог"));
        });
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [id]);

  if (error && !dialog) return <ManagerProblem message={error.message} setup={error.setup} />;
  if (!dialog) {
    return (
      <p className="flex items-center gap-2 p-8 text-[14px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Загружаю диалог…
      </p>
    );
  }

  const { session, turns } = dialog;
  const fields = filledFields(session.passport);
  const role = dialogRole(session.role);
  const kind = LEAD_KINDS.find((k) => k.kind === dialog.lead_kind)?.label ?? "";

  return (
    <article className="pb-10">
      <header className="px-5 pt-4 pb-4">
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 lg:hidden" onClick={onBack}>
          <ArrowLeft /> К списку
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.015em]">{dialogTitle(session)}</h2>
          <DialogLeadBadge code={dialog.lead_code} />
          {kind && <KindBadge label={kind} />}
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {channelLabel(session.channel)}
          {session.created_at && ` · начат ${new Date(session.created_at).toLocaleString("ru-RU")}`}
          {session.updated_at && ` · последняя реплика ${ago(session.updated_at)}`} · {messagesLabel(turns.length)}
          {role && ` · ${role}`}
        </p>
        {dialog.lead_code && (
          <p className="mt-2 text-[14px]">
            <Link href={`/manager?lead=${dialog.lead_code}`} className="text-primary underline underline-offset-2">
              Открыть заявку №{dialog.lead_code}
            </Link>
          </p>
        )}
      </header>

      <Block title="Паспорт задачи">
        {session.passport?.total ? (
          <p className="mb-3 text-[13px] tnum">
            {session.passport.filled} из {session.passport.total} полей · {session.passport.product_label}
          </p>
        ) : null}
        {fields.length > 0 ? (
          <dl className="grid grid-cols-[minmax(130px,200px)_1fr] gap-x-3 gap-y-1.5 text-[14px]">
            {fields.map((f) => (
              <Row key={f.key} label={f.label} value={`${f.value}${f.source === "client" ? " (клиент)" : ""}`} />
            ))}
          </dl>
        ) : (
          <p className="text-[14px] text-muted-foreground">Клиент пока ничего о себе и объекте не рассказал.</p>
        )}
      </Block>

      <Block title="Переписка">
        {turns.length === 0 ? <p className="text-[14px] text-muted-foreground">Переписки нет.</p> : <TurnList turns={turns} kb={kb} />}
      </Block>
    </article>
  );
}
