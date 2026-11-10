"use client";

import { BookOpen, Code2, Menu, MessageSquare, PanelLeft, SquarePen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { BrandLockup } from "@/components/brand";
import { ThemeToggle } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { getHealth } from "@/lib/api";
import type { Health } from "@/lib/types";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/playground", label: "Чат и отладка", icon: MessageSquare },
  { href: "/kb", label: "База знаний", icon: BookOpen },
  { href: "/widget", label: "Виджет для сайта", icon: Code2 },
];

interface ShellState {
  desktop: boolean;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellState>({ desktop: true, sidebarOpen: true, setSidebarOpen: () => {} });
export const useShell = () => useContext(ShellContext);

const COLLAPSE_KEY = "eb.sidebar.collapsed";

function HealthStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = () =>
      getHealth()
        .then((h) => {
          if (!alive) return;
          setHealth(h);
          setError("");
        })
        .catch((e: Error) => alive && setError(e.message));
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const ok = health && !error;
  const tone = ok ? (health.llm ? "bg-success" : "bg-warning") : error ? "bg-destructive" : "bg-dim";
  const label = ok ? (health.llm ? health.model.split("/").pop() : "Без модели") : error ? "API недоступен" : "Проверяю API…";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          />
        }
      >
        <span className={cn("size-2 shrink-0 rounded-full", tone)} />
        <span className="truncate">{label}</span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-xs">
        {ok ? (
          <div className="space-y-0.5 text-xs">
            <div>Модель: {health.llm ? health.model : "не настроена — ответы выдержкой из базы"}</div>
            <div>
              Поиск: BM25{health.dense ? " + эмбеддинги" : ""}
              {health.reranker ? " + реранкер" : ""}
            </div>
            <div>Схема ответа: {health.arch}</div>
            <div>
              База: {health.docs} документов, {health.chunks} разделов
            </div>
          </div>
        ) : (
          <span className="text-xs">
            {error || "Проверяю…"} Запустите: docker compose up
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarBody({
  onNew,
  children,
  onNavigate,
}: {
  onNew?: () => void;
  children?: React.ReactNode;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { desktop, setSidebarOpen } = useShell();
  const item =
    "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2.5 pr-2.5 pl-3.5">
        <Link href="/playground" className="min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50" onClick={onNavigate}>
          <BrandLockup />
        </Link>
        {desktop && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto text-muted-foreground hover:bg-sidebar-accent"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Скрыть боковую панель"
                />
              }
            >
              <PanelLeft />
            </TooltipTrigger>
            <TooltipContent>Скрыть боковую панель</TooltipContent>
          </Tooltip>
        )}
      </div>

      <nav className="shrink-0 space-y-0.5 px-2" aria-label="Разделы стенда">
        {onNew ? (
          <button
            type="button"
            className={item}
            onClick={() => {
              onNew();
              onNavigate?.();
            }}
          >
            <SquarePen className="size-[18px] text-muted-foreground" />
            Новый диалог
          </button>
        ) : (
          <Link href="/playground?new=1" className={item} onClick={onNavigate}>
            <SquarePen className="size-[18px] text-muted-foreground" />
            Новый диалог
          </Link>
        )}
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(item, active && "bg-sidebar-accent font-medium text-sidebar-foreground")}
            >
              <Icon className={cn("size-[18px]", active ? "text-sidebar-foreground" : "text-muted-foreground")} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-5 flex min-h-0 flex-1 flex-col">{children}</div>

      <div className="flex shrink-0 items-center gap-2 border-t border-sidebar-border px-2 py-2">
        <HealthStatus />
        <ThemeToggle />
      </div>
    </div>
  );
}

/**
 * Каркас как в Claude / ChatGPT: слева одна панель (навигация, история, статус, тема), справа рабочая область.
 * На широких экранах панель можно свернуть, на узких она выезжает поверх.
 */
export function AppShell({
  sidebar,
  onNew,
  children,
  wide,
}: {
  sidebar?: React.ReactNode;
  onNew?: () => void;
  children: React.ReactNode;
  /** Широкая панель — для дерева базы знаний с длинными названиями. */
  wide?: boolean;
}) {
  const width = wide ? 300 : 264;
  const desktop = useMediaQuery("(min-width: 1024px)", true);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- настройка хранится в браузере
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  const sidebarOpen = desktop ? !collapsed : mobileOpen;
  const setSidebarOpen = (open: boolean) => {
    if (desktop) {
      setCollapsed(!open);
      localStorage.setItem(COLLAPSE_KEY, open ? "0" : "1");
    } else setMobileOpen(open);
  };
  const state = { desktop, sidebarOpen, setSidebarOpen };

  return (
    <ShellContext.Provider value={state}>
      <div className="flex h-dvh min-h-0 w-full overflow-hidden">
        {desktop ? (
          <aside
            className={cn(
              "h-full shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out",
              !sidebarOpen && "border-r-0",
            )}
            style={{ width: sidebarOpen ? width : 0 }}
          >
            <div className="h-full" style={{ width }}>
              <SidebarBody onNew={onNew}>{sidebar}</SidebarBody>
            </div>
          </aside>
        ) : (
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="w-[288px] max-w-[85vw] gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground data-[side=left]:w-[288px]"
            >
              <SheetTitle className="sr-only">Навигация</SheetTitle>
              <SidebarBody onNew={onNew} onNavigate={() => setMobileOpen(false)}>
                {sidebar}
              </SidebarBody>
            </SheetContent>
          </Sheet>
        )}
        <main className="flex min-w-0 flex-1 flex-col bg-background">{children}</main>
      </div>
    </ShellContext.Provider>
  );
}

/** Верхняя строка рабочей области: кнопка панели (если она скрыта), заголовок, действия справа. */
export function PageBar({
  title,
  subtitle,
  icon: Icon,
  children,
  className,
}: {
  title?: React.ReactNode;
  /** Короткое пояснение рядом с заголовком, приглушённое. */
  subtitle?: React.ReactNode;
  /** Иконка раздела в плашке слева от заголовка. */
  icon?: React.ElementType;
  children?: React.ReactNode;
  className?: string;
}) {
  const { sidebarOpen, setSidebarOpen, desktop } = useShell();
  return (
    <div className={cn("flex h-14 shrink-0 items-center gap-2 px-3 sm:px-4", className)}>
      {!sidebarOpen && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground"
                onClick={() => setSidebarOpen(true)}
                aria-label="Показать боковую панель"
              />
            }
          >
            {desktop ? <PanelLeft /> : <Menu />}
          </TooltipTrigger>
          <TooltipContent>Показать боковую панель</TooltipContent>
        </Tooltip>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-1">
        {Icon && title && (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground shadow-[0_1px_2px_rgb(0_0_0/0.04)] dark:bg-card">
            <Icon className="size-[15px]" />
          </span>
        )}
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</span>
          {subtitle && <span className="hidden truncate text-[13px] text-muted-foreground md:inline">{subtitle}</span>}
        </div>
      </div>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}

/** Заголовок секции в сайдбаре (Сегодня, Документы…). */
export function SidebarLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-2.5 pt-3 pb-1.5 text-xs font-medium text-muted-foreground", className)}>{children}</div>;
}
