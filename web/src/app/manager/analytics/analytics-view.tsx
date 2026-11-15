"use client";

import { BarChart3, ClipboardCopy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell, PageBar } from "@/components/app-shell";
import { DemoBanner, ManagerProblem, ManagerTabs } from "@/components/manager/manager-chrome";
import { Button } from "@/components/ui/button";
import { type Days, type Report, PERIODS, barWidth, gapsText, getAnalytics, percent, stepKept } from "@/lib/analytics";
import { ManagerError } from "@/lib/manager";
import { cn } from "@/lib/utils";

/** Простая аналитика (T6): воронка, заявки по оценке, типу и каналу, пробелы базы. Таблицы и полосы, без графиков. */
export function AnalyticsView() {
  const [days, setDays] = useState<Days>(7);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<ManagerError | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getAnalytics(days, ctrl.signal)
      .then((r) => {
        setReport(r);
        setError(null);
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(e instanceof ManagerError ? e : new ManagerError("Не удалось загрузить аналитику"));
      });
    return () => ctrl.abort();
  }, [days]);

  return (
    <AppShell>
      <PageBar icon={BarChart3} title="Менеджер" subtitle="воронка и пробелы базы">
        <div className="flex gap-1" role="group" aria-label="Период">
          {PERIODS.map((p) => (
            <Button key={p} size="sm" variant={days === p ? "default" : "outline"} aria-pressed={days === p} onClick={() => setDays(p)}>
              {p} дней
            </Button>
          ))}
        </div>
      </PageBar>
      <ManagerTabs />
      <DemoBanner />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && !report ? (
          <ManagerProblem message={error.message} setup={error.setup} />
        ) : !report ? (
          <p className="p-6 text-[14px] text-muted-foreground">Загружаю…</p>
        ) : (
          <ReportBody report={report} />
        )}
      </div>
    </AppShell>
  );
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border p-4">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {note && <p className="mt-0.5 text-[12px] text-muted-foreground">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Строка с полосой: подпись, число и сплошная полоса по доле от максимума. */
function BarRow({ label, count, max, extra }: { label: string; count: number; max: number; extra?: string }) {
  return (
    <div className="grid grid-cols-[minmax(120px,200px)_1fr_auto] items-center gap-3 py-1 text-[14px]">
      <span className="truncate">{label}</span>
      <div className="h-3 rounded-full bg-dim" aria-hidden>
        <div className="h-full rounded-full bg-primary" style={{ width: `${barWidth(count, max)}%` }} />
      </div>
      <span className="tnum text-right">
        {count}
        {extra && <span className="ml-2 text-[12px] text-muted-foreground">{extra}</span>}
      </span>
    </div>
  );
}

function Buckets({ items }: { items: { key: string; label: string; count: number }[] }) {
  const max = Math.max(0, ...items.map((b) => b.count));
  return (
    <div>
      {items.map((b) => (
        <BarRow key={b.key} label={b.label} count={b.count} max={max} />
      ))}
    </div>
  );
}

function ReportBody({ report }: { report: Report }) {
  const sessions = report.funnel[0]?.count ?? 0;
  const copyGaps = async () => {
    try {
      await navigator.clipboard.writeText(gapsText(report.gaps, report.days));
      toast.success("Список скопирован");
    } catch {
      toast.error("Не удалось скопировать");
    }
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-4 sm:p-6 lg:grid-cols-2">
      <div className="lg:col-span-2">
        <Panel
          title="Воронка"
          note={`Сессии, созданные за ${report.days} дней. «Паспорт заполнен» — не меньше ${report.min_fields} полей паспорта задачи, контакты не в счёт.`}
        >
          {sessions === 0 ? (
            <p className="text-[14px] text-muted-foreground">За период сессий нет — задайте вопрос в чате.</p>
          ) : (
            report.funnel.map((s, i) => (
              <BarRow
                key={s.key}
                label={s.label}
                count={s.count}
                max={sessions}
                extra={`${percent(s.share)}${i > 0 ? ` · от прошлого шага ${stepKept(report.funnel, i)}` : ""}`}
              />
            ))
          )}
        </Panel>
      </div>

      <Panel title="Заявки по оценке" note={`Всего заявок за период: ${report.leads}`}>
        <Buckets items={report.by_grade} />
      </Panel>
      <Panel title="Заявки по типу">
        <Buckets items={report.by_kind} />
      </Panel>

      <div className="lg:col-span-2">
        <Panel title="По каналу" note="Стенд (playground) и виджет на сайте (embed): сессии и заявки из них.">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b text-left text-[12px] text-muted-foreground">
                <th className="py-1.5 font-medium">Канал</th>
                <th className="py-1.5 text-right font-medium">Сессии</th>
                <th className="py-1.5 text-right font-medium">Заявки</th>
              </tr>
            </thead>
            <tbody>
              {report.by_channel.map((c) => (
                <tr key={c.key} className="border-b last:border-0">
                  <td className="py-1.5">{c.label}</td>
                  <td className="tnum py-1.5 text-right">{c.sessions}</td>
                  <td className="tnum py-1.5 text-right">{c.leads}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <div className="lg:col-span-2">
        <Panel
          title="Пробелы базы"
          note={`Вопросы, на которые бот дал запасной ответ: ${report.fallbacks} из ${report.answers} ответов (${percent(report.answers > 0 ? report.fallbacks / report.answers : 0, report.answers)}). Уверенность ответа в журнале не хранится, поэтому признак один — запасной ответ. Телефоны и почта в тексте скрыты.`}
        >
          {report.gaps.length === 0 ? (
            <p className="text-[14px] text-muted-foreground">Запасных ответов за период нет.</p>
          ) : (
            <>
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b text-left text-[12px] text-muted-foreground">
                    <th className="py-1.5 font-medium">Вопрос</th>
                    <th className="py-1.5 text-right font-medium">Раз</th>
                    <th className="hidden py-1.5 text-right font-medium sm:table-cell">Последний</th>
                  </tr>
                </thead>
                <tbody>
                  {report.gaps.map((g) => (
                    <tr key={g.question} className="border-b align-top last:border-0">
                      <td className={cn("py-1.5 pr-3 break-words")}>{g.question}</td>
                      <td className="tnum py-1.5 text-right">{g.count}</td>
                      <td className="hidden py-1.5 text-right whitespace-nowrap text-muted-foreground sm:table-cell">
                        {new Date(g.last_at).toLocaleDateString("ru-RU")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Button className="mt-3" size="sm" variant="outline" onClick={copyGaps}>
                <ClipboardCopy /> Скопировать для команды контента
              </Button>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
