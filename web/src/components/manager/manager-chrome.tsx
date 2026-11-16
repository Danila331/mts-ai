"use client";

import { BarChart3, Inbox, MessagesSquare, Sparkles, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/manager", label: "Заявки", icon: Inbox, exact: true },
  { href: "/manager/dialogs", label: "Диалоги", icon: MessagesSquare, exact: false },
  { href: "/manager/analytics", label: "Аналитика", icon: BarChart3, exact: false },
  { href: "/manager/copilot", label: "Копилот", icon: Sparkles, exact: false },
];

/** Вкладки раздела менеджера: заявки, диалоги, аналитика (T6), копилот (T11). */
export function ManagerTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex shrink-0 gap-1 border-b px-3 sm:px-4" aria-label="Разделы менеджера">
      {TABS.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px flex h-10 items-center gap-2 border-b-2 px-3 text-[14px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
              active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" strokeWidth={1.75} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Плашка на экранах менеджера: входа нет, поэтому данные должны быть только тестовыми. */
export function DemoBanner() {
  return (
    <div role="note" className="flex shrink-0 items-center gap-2 bg-tone-warning px-4 py-2 text-[13px] font-medium text-white">
      <TriangleAlert className="size-4 shrink-0" />
      Демо-экран менеджера без входа — на стенде только тестовые данные.
    </div>
  );
}

/** Не задан токен менеджера или API не отвечает: говорим, что делать. */
export function ManagerProblem({ message, setup }: { message: string; setup: boolean }) {
  return (
    <div className="m-6 max-w-xl rounded-xl border p-5 text-[14px]" role="alert">
      <p className="font-semibold">{setup ? "Экран менеджера не настроен" : "Не удалось загрузить данные"}</p>
      <p className="mt-2 text-muted-foreground">{message}</p>
      {setup && (
        <p className="mt-3 font-mono text-[12px]">
          EB_MANAGER_TOKEN=&lt;секрет&gt; <span className="text-muted-foreground"># в .env, для служб web и api</span>
        </p>
      )}
    </div>
  );
}
