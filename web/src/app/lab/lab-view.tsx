"use client";

import { AlertTriangle, ChevronRight, FlaskConical, HelpCircle, Hash, ShieldCheck, UserRound } from "lucide-react";
import Link from "next/link";
import { AppShell, PageBar } from "@/components/app-shell";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { type Dialog, type LeadStatus, MOCK_COMMAND, type PersonasReport, RUN_COMMAND, type Summary, type Turn } from "./report";

const LEAD: Record<LeadStatus, { label: string; tone: "ok" | "warn" | "bad" }> = {
  timely: { label: "заявка вовремя", tone: "ok" },
  early: { label: "заявка рано", tone: "warn" },
  missing: { label: "заявка упущена", tone: "bad" },
  none_ok: { label: "заявка не нужна", tone: "ok" },
  extra: { label: "лишняя заявка", tone: "warn" },
};

const TONE = {
  ok: "bg-success-soft text-tone-success",
  warn: "bg-warning-soft text-tone-warning",
  bad: "bg-destructive-soft text-tone-danger",
  plain: "bg-muted text-muted-foreground",
};

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

function Chip({ tone = "plain", children }: { tone?: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium", TONE[tone])}>
      {children}
    </span>
  );
}

export function LabView({ report }: { report: PersonasReport | null }) {
  return (
    <AppShell>
      <PageBar icon={FlaskConical} title="Стресс-тест" subtitle="сценарные диалоги по пяти персонам кейса" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-5 pt-4 pb-32 sm:px-6">
          {report ? <ReportView report={report} /> : <NoRun />}
        </div>
      </div>
    </AppShell>
  );
}

function CommandBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="overflow-hidden rounded-xl bg-[#17191c] ring-1 ring-border dark:ring-white/8">
      <div className="flex h-9 items-center border-b border-white/8 px-4">
        <span className="font-mono text-xs text-white/50">{label}</span>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-relaxed text-white/90">{code}</pre>
    </div>
  );
}

function NoRun() {
  return (
    <div className="mt-6 space-y-6">
      <div className="flex gap-3 rounded-xl bg-muted/60 px-4 py-3.5 text-[14px] leading-relaxed">
        <FlaskConical className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">Прогон ещё не снимали:</span> он платный и запускается только с
          разрешения владельца ядра. Команда — ниже; после неё отчёт попадает на эту страницу.
        </p>
      </div>
      <CommandBlock label="настоящий прогон (платно)" code={RUN_COMMAND} />
      <About />
      <CommandBlock label="бесплатная проверка стенда на заглушке API (на эту страницу не попадает)" code={MOCK_COMMAND} />
    </div>
  );
}

function About() {
  return (
    <section className="text-[14px] leading-relaxed text-muted-foreground">
      <h2 className="text-[13px] font-medium text-foreground">Что измеряется</h2>
      <p className="mt-1.5">
        Пять аудиторий кейса — МСБ, энергетик, СНТ/УК/ТСЖ, сетевая компания, региональный менеджер МТС — ведут
        многоходовые диалоги с тем же ядром, что отвечает в чате. Реплики клиента записаны заранее
        (<span className="font-mono text-[12.5px]">eval/personas/scenarios.jsonl</span>), второй модели нет: прогон
        воспроизводим. По каждому ответу считаются числа вне базы, уточняющий вопрос и момент предложения заявки;
        заполнение паспорта клиента появится после T2.
      </p>
    </section>
  );
}

function ReportView({ report }: { report: PersonasReport }) {
  const date = new Date(report.created_at).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });
  return (
    <div className="space-y-9">
      {report.mock && (
        <div
          role="alert"
          className="mt-2 flex gap-3 rounded-xl bg-warning-soft px-5 py-4 text-tone-warning ring-1 ring-tone-warning/30"
        >
          <AlertTriangle className="mt-1 size-5 shrink-0" aria-hidden />
          <div>
            <p className="text-[18px] font-semibold leading-snug">
              Демонстрационный прогон на заглушке, не результат модели
            </p>
            <p className="mt-1 text-[13.5px]">Ответы написала заглушка API: цифры ниже проверяют только вёрстку и счёт метрик.</p>
          </div>
        </div>
      )}

      <section>
        <p className="font-mono text-[11.5px] text-muted-foreground/80">
          {date} · {report.model || "модель не указана"} · схема {report.config.arch}, стиль {report.config.style} ·
          режим {report.config.mode}
          {report.commit && ` · коммит ${report.commit}`}
        </p>
        <h1 className="mt-2 text-[22px] font-semibold tracking-[-0.02em]">
          {report.totals.scenarios} сценариев, {report.totals.turns} реплик клиента
        </h1>
        <SummaryTable report={report} />
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          Заполнение паспорта — {report.totals.passport_fill_note}. Вызовов модели за прогон: чат{" "}
          {report.totals.llm_calls.chat}, эмбеддинги {report.totals.llm_calls.embed}, реранкер{" "}
          {report.totals.llm_calls.rerank}.
        </p>
      </section>

      <Heuristics report={report} />

      {report.personas.map((p) => (
        <section key={p.persona} aria-labelledby={`p-${p.persona}`}>
          <h2 id={`p-${p.persona}`} className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
            <UserRound className="size-3.5" aria-hidden />
            {p.name}
          </h2>
          <ul className="mt-2 divide-y border-y">
            {report.dialogs
              .filter((d) => d.persona === p.persona)
              .map((d) => (
                <DialogRow key={d.id} dialog={d} />
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SummaryTable({ report }: { report: PersonasReport }) {
  const rows: { key: string; name: string; s: Summary; total?: boolean }[] = [
    ...report.personas.map((p) => ({ key: p.persona, name: p.name, s: p as Summary })),
    { key: "total", name: "Итого", s: report.totals, total: true },
  ];
  const head = "px-3 py-2 text-left text-[12px] font-medium text-muted-foreground whitespace-nowrap";
  const cell = "px-3 py-2.5 tabular-nums whitespace-nowrap";
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border">
      <table className="w-full text-[13.5px]">
        <thead className="border-b bg-surface dark:bg-card">
          <tr>
            <th className={head}>Персона</th>
            <th className={cn(head, "text-right")}>Сцен.</th>
            <th className={cn(head, "text-right")}>Реплик</th>
            <th className={cn(head, "text-right")} title="Доля ответов без чисел, которых нет в базе и репликах клиента">
              Без чисел вне базы
            </th>
            <th className={cn(head, "text-right")} title="Доля ответов со знаком «?»">
              Уточн. вопрос
            </th>
            <th className={cn(head, "text-right")} title="Сценарии, где заявка предложена вовремя или не нужна и не предложена">
              Заявка к месту
            </th>
            <th className={cn(head, "text-right")} title="Появится после T2">
              Паспорт
            </th>
            <th className={cn(head, "text-right")} title="Ответы-заглушки «уточните у специалиста» из-за сбоя или проверки">
              Отказы
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(({ key, name, s, total }) => (
            <tr key={key} className={cn(total && "bg-muted/40 font-medium")}>
              <td className="min-w-40 px-3 py-2.5">{name}</td>
              <td className={cn(cell, "text-right")}>{s.scenarios}</td>
              <td className={cn(cell, "text-right")}>{s.turns}</td>
              <td className={cn(cell, "text-right")}>{pct(s.clean_numbers_rate)}</td>
              <td className={cn(cell, "text-right")}>{pct(s.question_rate)}</td>
              <td className={cn(cell, "text-right")}>
                {pct(s.lead_ok_rate)}
                <span className="ml-1.5 text-[11.5px] font-normal text-muted-foreground">
                  {s.lead.timely + s.lead.none_ok}/{s.scenarios}
                </span>
              </td>
              <td className={cn(cell, "text-right text-muted-foreground")}>—</td>
              <td className={cn(cell, "text-right")}>{pct(s.fallback_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Heuristics({ report }: { report: PersonasReport }) {
  const names: Record<string, string> = {
    clean_numbers: "Числа вне базы",
    question: "Уточняющий вопрос",
    lead_offer: "Предложение заявки",
    lead_timing: "Момент заявки",
    passport_fill: "Паспорт",
  };
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[panel-open]:rotate-90" aria-hidden />
        Как считаются метрики (эвристики)
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="mt-3 space-y-2.5 text-[13.5px] leading-relaxed">
          {Object.entries(report.heuristics).map(([k, v]) => (
            <div key={k}>
              <dt className="font-medium">{names[k] ?? k}</dt>
              <dd className="text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DialogRow({ dialog }: { dialog: Dialog }) {
  const lead = LEAD[dialog.lead.status];
  const unknown = dialog.turns.filter((t) => t.unknown_numbers.length).length;
  const questions = dialog.turns.filter((t) => t.asked_question).length;
  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="group flex w-full items-center gap-2.5 py-3 text-left">
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90"
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium">{dialog.title}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {dialog.id} · {dialog.turns.length} реплик · объект и задача известны с реплики {dialog.lead.context_turn}
            </span>
          </span>
          <span className="flex shrink-0 flex-wrap justify-end gap-1">
            <Chip tone={lead.tone}>
              {lead.label}
              {dialog.lead.first_offer_turn ? ` · ${dialog.lead.first_offer_turn}` : ""}
            </Chip>
            <Chip>
              «?» {questions}/{dialog.turns.length}
            </Chip>
            {unknown > 0 && <Chip tone="bad">числа вне базы: {unknown}</Chip>}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ol className="space-y-5 pt-1 pb-5 pl-6">
            {dialog.turns.map((t) => (
              <TurnView key={t.n} turn={t} />
            ))}
          </ol>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const guard = Object.keys(turn.guard).filter((k) => turn.guard[k] && k !== "too_long" && k !== "unknown_numbers");
  return (
    <li className="space-y-2.5">
      <div className="flex justify-end">
        <p className="max-w-[min(85%,36rem)] rounded-3xl bg-muted px-4 py-2.5 text-[14px] leading-relaxed dark:bg-accent">
          {turn.client}
        </p>
      </div>
      <p className="text-[14.5px] leading-relaxed">{turn.bot}</p>
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-1 font-mono text-[11px] text-muted-foreground">#{turn.n}</span>
        {turn.asked_question && (
          <Chip>
            <HelpCircle className="size-3" aria-hidden />
            вопрос
          </Chip>
        )}
        {turn.lead_offer && <Chip tone="ok">заявка</Chip>}
        {turn.unknown_numbers.length > 0 ? (
          <Chip tone="bad">
            <Hash className="size-3" aria-hidden />
            вне базы: {turn.unknown_numbers.join(", ")}
          </Chip>
        ) : (
          <Chip tone="ok">
            <ShieldCheck className="size-3" aria-hidden />
            числа из базы
          </Chip>
        )}
        {guard.length > 0 && <Chip tone="warn">проверка ядра: {guard.join(", ")}</Chip>}
        {turn.fallback && <Chip tone="bad">отказ{turn.error ? `: ${turn.error}` : ""}</Chip>}
        <span className="ml-1 font-mono text-[11px] text-muted-foreground">
          {(turn.ms / 1000).toFixed(1)} c · чат {turn.llm_calls.chat}
        </span>
      </div>
      {turn.sources.length > 0 && (
        <p className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
          {turn.sources.map((s, i) =>
            s.chunk_id ? (
              <Link key={i} href={`/kb?chunk=${s.chunk_id}`} className="hover:text-brand-text hover:underline">
                {s.doc}
                {s.whole ? "" : `#${s.chunk_id.slice(0, 6)}`}
              </Link>
            ) : (
              <span key={i}>{s.doc}</span>
            ),
          )}
        </p>
      )}
    </li>
  );
}
