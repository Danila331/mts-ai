"use client";

import {
  BookOpen,
  ChevronDown,
  Code2,
  FileCheck2,
  FlaskConical,
  Menu,
  MessageSquare,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { BrandLockup } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
  { href: "/check-data", label: "Проверить выгрузку", icon: FileCheck2 },
  { href: "/manager/copilot", label: "Копилот менеджера", icon: Sparkles },
  { href: "/lab", label: "Стресс-тест", icon: FlaskConical },
  { href: "/settings", label: "Настройки RAG", icon: SlidersHorizontal },
];

/** Пункт сайдбара как в Claude: 36px, тонкая иконка в цвет текста, нейтральная плашка при наведении и у текущего. */
const ITEM =
  "flex h-9 w-full items-center gap-3 rounded-lg px-2.5 text-[14px] text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50";

interface ShellState {
  desktop: boolean;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

const ShellContext = createContext<ShellState>({ desktop: true, sidebarOpen: true, setSidebarOpen: () => {} });
export const useShell = () => useContext(ShellContext);

const COLLAPSE_KEY = "eb.sidebar.collapsed";

/** Поиск по диалогам: в покое выглядит как обычный пункт «Поиск», по клику — поле ввода. */
export interface SidebarSearch {
  value: string;
  onChange: (value: string) => void;
}

function SearchItem({ search }: { search: SidebarSearch }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <label className={cn(ITEM, "cursor-text focus-within:bg-sidebar-accent")}>
      <Search className="size-[18px] shrink-0 text-sidebar-foreground/80" strokeWidth={1.75} />
      <input
        ref={input}
        value={search.value}
        onChange={(e) => search.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            search.onChange("");
            input.current?.blur();
          }
        }}
        placeholder="Поиск"
        aria-label="Поиск по диалогам"
        className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-sidebar-foreground focus:placeholder:text-muted-foreground"
      />
      {search.value && (
        <button
          type="button"
          onClick={() => search.onChange("")}
          aria-label="Очистить поиск"
          className="-mr-1 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </label>
  );
}

/**
 * Нижняя строка сайдбара — на месте аккаунта в Claude: знак, название стенда и модель со статусом.
 * По клику — сводка о подключённом API.
 */
function StandStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);

  const load = useCallback(() => {
    getHealth()
      .then((h) => {
        if (!alive.current) return;
        setHealth(h);
        setError("");
      })
      .catch((e: Error) => alive.current && setError(e.message));
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load]);

  const ok = health && !error;
  const tone = ok ? (health.llm ? "bg-success" : "bg-warning") : error ? "bg-destructive" : "bg-dim";
  const label = ok ? (health.llm ? health.model.split("/").pop() : "без модели") : error ? "API недоступен" : "проверяю API…";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex h-12 w-full items-center gap-2.5 rounded-lg px-2 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-sidebar-accent"
            aria-label="Состояние стенда"
          />
        }
      >
        {/* как аватар аккаунта в Claude: нейтральный кружок с буквой, статус API — точкой на углу */}
        <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-[13px] font-semibold text-background">
          E
          <span
            className={cn("absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-sidebar", tone)}
            aria-hidden
          />
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-[14px]">
          <span className="shrink-0 font-medium">Стенд</span>
          <span className="truncate text-muted-foreground">· {label}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={6}>
        <dl className="space-y-2 px-2 pt-1.5 pb-2 text-[13px]">
          {ok ? (
            <>
              <div>
                <dt className="text-xs text-muted-foreground">Модель</dt>
                <dd className="font-mono text-[12px] break-all">{health.llm ? health.model : "не настроена — ответ выдержкой из базы"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Поиск</dt>
                <dd>
                  BM25{health.dense ? " + эмбеддинги" : ""}
                  {health.reranker ? " + реранкер" : ""} · схема {health.arch}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">База знаний</dt>
                <dd className="tnum">
                  {health.docs} документов, {health.chunks} разделов
                </dd>
              </div>
            </>
          ) : (
            <div className="text-muted-foreground">{error ? `${error}. Запустите: docker compose up` : "Проверяю API…"}</div>
          )}
        </dl>
        <DropdownMenuItem onClick={load} closeOnClick={false}>
          <RefreshCw /> Проверить ещё раз
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarBody({
  onNew,
  search,
  children,
  onNavigate,
}: {
  onNew?: () => void;
  search?: SidebarSearch;
  children?: React.ReactNode;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { desktop, setSidebarOpen } = useShell();
  const newLabel = (
    <>
      <Plus className="size-[18px] shrink-0 text-sidebar-foreground/80" strokeWidth={1.75} />
      Новый диалог
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2.5 pr-2 pl-3.5">
        <Link
          href="/playground"
          className="min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onNavigate}
        >
          <BrandLockup />
        </Link>
        {desktop && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
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

      <nav className="shrink-0 space-y-px px-2" aria-label="Разделы стенда">
        {onNew ? (
          <button
            type="button"
            className={ITEM}
            onClick={() => {
              onNew();
              onNavigate?.();
            }}
          >
            {newLabel}
          </button>
        ) : (
          <Link href="/playground?new=1" className={ITEM} onClick={onNavigate}>
            {newLabel}
          </Link>
        )}
        {search && <SearchItem search={search} />}
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(ITEM, active && "bg-sidebar-accent")}
            >
              <Icon className="size-[18px] shrink-0 text-sidebar-foreground/80" strokeWidth={1.75} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-4 flex min-h-0 flex-1 flex-col">{children}</div>

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <StandStatus />
      </div>
    </div>
  );
}

/**
 * Каркас как в Claude / ChatGPT: слева одна панель (новый диалог, поиск, разделы, недавние, статус стенда),
 * справа рабочая область.
 * На широких экранах панель можно свернуть, на узких она выезжает поверх.
 */
export function AppShell({
  sidebar,
  onNew,
  search,
  children,
  wide,
}: {
  sidebar?: React.ReactNode;
  onNew?: () => void;
  /** Пункт «Поиск» в навигации — только там, где есть что искать (диалоги). */
  search?: SidebarSearch;
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
              <SidebarBody onNew={onNew} search={search}>
                {sidebar}
              </SidebarBody>
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
              <SidebarBody onNew={onNew} search={search} onNavigate={() => setMobileOpen(false)}>
                {sidebar}
              </SidebarBody>
            </SheetContent>
          </Sheet>
        )}
        <main className="relative flex min-w-0 flex-1 flex-col bg-background">{children}</main>
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
          {typeof title === "string" ? (
            <span className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</span>
          ) : (
            title
          )}
          {subtitle && <span className="hidden truncate text-[13px] text-muted-foreground md:inline">{subtitle}</span>}
        </div>
      </div>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}

/** Заголовок секции в сайдбаре (Недавние, Документы…). */
export function SidebarLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-2.5 pt-2 pb-1.5 text-xs font-medium text-muted-foreground", className)}>{children}</div>;
}
