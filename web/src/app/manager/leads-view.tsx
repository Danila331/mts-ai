"use client";

import { Inbox } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AppShell, PageBar } from "@/components/app-shell";
import { LeadCardView } from "@/components/manager/lead-card";
import { DemoBanner, ManagerProblem, ManagerTabs } from "@/components/manager/manager-chrome";
import { GradeBadge, KindBadge, StatusBadge } from "@/components/manager/badges";
import {
  FRESH_MS,
  ManagerError,
  POLL_MS,
  type LeadItem,
  type LeadList,
  type LeadStatus,
  ago,
  getLeads,
  leadTitle,
  newCodes,
  newestFirst,
} from "@/lib/manager";
import { cn } from "@/lib/utils";

/**
 * Вкладка «Заявки» (T5): слева входящие, справа карточка. Список опрашивается раз в 10 секунд — на демо видно,
 * как заявка из чата «прилетает» менеджеру; новая подсвечивается, пока её не откроют.
 */
export function LeadsView() {
  const wanted = useSearchParams().get("lead") ?? "";
  const initialCode = /^[0-9a-f]{6,32}$/.test(wanted) ? wanted : null;
  const [list, setList] = useState<LeadList | null>(null);
  const [error, setError] = useState<ManagerError | null>(null);
  const [selected, setSelected] = useState<string | null>(initialCode);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(0);
  const seen = useRef<ReadonlySet<string> | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getLeads(100, signal);
      const items = newestFirst(next.items);
      const added = newCodes(seen.current, items);
      const first = seen.current === null;
      seen.current = new Set(items.map((i) => i.code));
      setList({ ...next, items });
      setError(null);
      setNow(Date.now());
      // На широком экране сразу открываем самую свежую заявку — правая половина не пустует.
      if (first && items.length > 0 && window.matchMedia("(min-width: 1024px)").matches) {
        setSelected((cur) => cur ?? items[0].code);
      }
      if (added.length > 0) {
        setFresh((prev) => new Set([...prev, ...added]));
        toast.success(added.length === 1 ? `Новая заявка №${added[0]}` : `Новых заявок: ${added.length}`);
        setTimeout(() => setFresh((prev) => new Set([...prev].filter((c) => !added.includes(c)))), FRESH_MS);
      }
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof ManagerError ? e : new ManagerError("Не удалось загрузить заявки"));
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    // Первый запрос — таймером, а не в теле эффекта: состояние выставляется после ответа.
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

  const open = (code: string) => {
    setSelected(code);
    setFresh((prev) => new Set([...prev].filter((c) => c !== code)));
  };

  // Карточка сменила статус — строка списка обновляется, не дожидаясь опроса.
  const onStatus = (code: string, status: LeadStatus, label: string) =>
    setList((cur) =>
      cur ? { ...cur, items: cur.items.map((i) => (i.code === code ? { ...i, status, status_label: label } : i)) } : cur,
    );

  return (
    <AppShell>
      <PageBar icon={Inbox} title="Менеджер" subtitle="входящие заявки" />
      <ManagerTabs />
      <DemoBanner />
      {error && !list ? (
        <ManagerProblem message={error.message} setup={error.setup} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(320px,400px)_1fr]">
          <section
            aria-label="Список заявок"
            className={cn("min-h-0 overflow-y-auto border-r", selected && "hidden lg:block")}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-2 text-[12px] text-muted-foreground">
              <span>{list ? `Заявок: ${list.total}` : "Загружаю…"}</span>
              <span>{error ? "нет связи, повторяю…" : "обновляется каждые 10 с"}</span>
            </div>
            {list && list.items.length === 0 && (
              <p className="p-6 text-[14px] text-muted-foreground">
                Заявок пока нет. Оставьте заявку в чате на «Чат и отладка» — она появится здесь сама.
              </p>
            )}
            <ul>
              {list?.items.map((l) => (
                <LeadRow key={l.code} lead={l} now={now} active={l.code === selected} fresh={fresh.has(l.code)} onOpen={open} />
              ))}
            </ul>
          </section>
          <section aria-label="Карточка заявки" className={cn("min-h-0 overflow-y-auto", !selected && "hidden lg:block")}>
            {selected ? (
              <LeadCardView key={selected} code={selected} onBack={() => setSelected(null)} onStatus={onStatus} />
            ) : (
              <p className="p-8 text-[14px] text-muted-foreground">Выберите заявку слева.</p>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function LeadRow({
  lead,
  now,
  active,
  fresh,
  onOpen,
}: {
  lead: LeadItem;
  now: number;
  active: boolean;
  fresh: boolean;
  onOpen: (code: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(lead.code)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "block w-full border-b px-4 py-3 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
          active && "bg-muted",
          // Новая заявка: сплошная красная кромка слева, без прозрачных подложек.
          fresh && "border-l-4 border-l-primary pl-3",
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[14px] font-medium">{leadTitle(lead)}</span>
          <span className="shrink-0 text-[12px] text-muted-foreground" title={new Date(lead.created_at).toLocaleString("ru-RU")}>
            {ago(lead.created_at, now)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="font-mono">№{lead.code}</span>
          <span className="truncate">{lead.product_label}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {fresh && <span className="rounded-4xl bg-primary px-2 py-0.5 text-[11px] font-medium text-white">Новая</span>}
          <GradeBadge grade={lead.grade} label={lead.grade_label} />
          <KindBadge label={lead.kind_label} />
          <StatusBadge status={lead.status} label={lead.status_label} />
        </div>
      </button>
    </li>
  );
}
