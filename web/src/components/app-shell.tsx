"use client";

import {
  BookOpen,
  Check,
  ChevronsUpDown,
  Code2,
  FileText,
  Menu,
  MessageSquare,
  Monitor,
  Moon,
  PanelLeft,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SquarePen,
  Sun,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { BrandLockup } from "@/components/brand";
import { Shortcut } from "@/components/shortcut";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useKb } from "@/hooks/use-kb";
import { useMediaQuery } from "@/hooks/use-media-query";
import { getHealth } from "@/lib/api";
import type { Health, Session } from "@/lib/types";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/playground", label: "Чат и отладка", icon: MessageSquare },
  { href: "/kb", label: "База знаний", icon: BookOpen },
  { href: "/widget", label: "Виджет для сайта", icon: Code2 },
  { href: "/settings", label: "Настройки RAG", icon: SlidersHorizontal },
];

const SESSIONS_KEY = "eb.playground.sessions.v1";
const COLLAPSE_KEY = "eb.sidebar.collapsed";

/** Пункт сайдбара: 32px, иконка 16px в тон текста, нейтральная плашка при наведении и у текущего. */
export const SIDEBAR_ITEM =
  "group/item flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-[13px] text-sidebar-foreground/90 outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-foreground";
const ICON = "size-4 shrink-0 text-muted-foreground group-hover/item:text-sidebar-foreground";

interface ShellState {
  desktop: boolean;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  openPalette: () => void;
}

const ShellContext = createContext<ShellState>({
  desktop: true,
  sidebarOpen: true,
  setSidebarOpen: () => {},
  openPalette: () => {},
});
export const useShell = () => useContext(ShellContext);

// ---------- Палитра команд ⌘K ----------

function readSessions(): Session[] {
  try {
    const list = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]") as Session[];
    return list.filter((s) => s.messages.length > 0).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

const THEMES = [
  { value: "light", label: "Светлая тема", icon: Sun },
  { value: "dark", label: "Тёмная тема", icon: Moon },
  { value: "system", label: "Тема как в системе", icon: Monitor },
] as const;

function PaletteBody({
  close,
  onNew,
  onSelectSession,
}: {
  close: () => void;
  onNew?: () => void;
  onSelectSession?: (id: string) => void;
}) {
  const router = useRouter();
  const { setTheme } = useTheme();
  const [sessions] = useState(readSessions);
  const { kb } = useKb();
  const run = (fn: () => void) => {
    close();
    fn();
  };

  return (
    <>
      <CommandInput placeholder="Найти диалог, документ или команду…" />
      <CommandList className="max-h-[min(60vh,420px)]">
        <CommandEmpty>Ничего не нашлось</CommandEmpty>
        <CommandGroup heading="Действия">
          <CommandItem value="новый диалог" onSelect={() => run(() => (onNew ? onNew() : router.push("/playground?new=1")))}>
            <SquarePen /> Новый диалог
            <CommandShortcut>
              <Shortcut keys={["mod", "shift", "O"]} />
            </CommandShortcut>
          </CommandItem>
          {THEMES.map(({ value, label, icon: Icon }) => (
            <CommandItem key={value} value={label} onSelect={() => run(() => setTheme(value))}>
              <Icon /> {label}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Разделы">
          {NAV.map(({ href, label, icon: Icon }) => (
            <CommandItem key={href} value={label} onSelect={() => run(() => router.push(href))}>
              <Icon /> {label}
            </CommandItem>
          ))}
        </CommandGroup>
        {sessions.length > 0 && (
          <CommandGroup heading="Диалоги">
            {sessions.slice(0, 30).map((s) => (
              <CommandItem
                key={s.id}
                value={`${s.title} ${s.id}`}
                keywords={s.messages.slice(0, 4).map((m) => m.content.slice(0, 80))}
                onSelect={() =>
                  run(() => (onSelectSession ? onSelectSession(s.id) : router.push(`/playground?s=${s.id}`)))
                }
              >
                <MessageSquare /> <span className="min-w-0 flex-1 truncate">{s.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {kb && (
          <CommandGroup heading="База знаний">
            {kb.data.docs.map((d) => (
              <CommandItem
                key={d.doc}
                value={`${d.title} ${d.doc}`}
                onSelect={() => run(() => router.push(`/kb?doc=${encodeURIComponent(d.doc)}`))}
              >
                <FileText /> <span className="min-w-0 flex-1 truncate">{d.title}</span>
                {/* data-slot прячет пустую галочку пункта, и имя файла встаёт ровно к правому краю */}
                <span data-slot="command-shortcut" className="ml-auto shrink-0 pl-3 text-right font-mono text-[11px] text-muted-foreground">
                  {d.doc.split("/").pop()?.replace(/\.md$/, "")}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </>
  );
}

// ---------- Статус стенда ----------

/**
 * Нижняя строка сайдбара — на месте аккаунта в Claude: модель и состояние API.
 * По клику — сводка о модели, поиске и базе и выбор темы.
 */
function StandStatus() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const { theme, setTheme } = useTheme();

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
  const model = ok ? (health.llm ? health.model.split("/").pop() : "без модели") : error ? "API недоступен" : "проверяю API…";
  const rows = ok
    ? [
        { label: "Модель", value: health.llm ? health.model : "не настроена", mono: true },
        {
          label: "Поиск",
          value: ["BM25", health.dense && "эмбеддинги", health.reranker && "реранкер"].filter(Boolean).join(" + "),
        },
        { label: "Схема", value: health.arch, mono: true },
        { label: "База", value: `${health.docs} док. · ${health.chunks} разд.` },
      ]
    : [];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-sidebar-accent"
            aria-label={`Состояние стенда: ${model}`}
          />
        }
      >
        <span className={cn("size-2 shrink-0 rounded-full", tone)} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-tight font-medium">Стенд EnergyTool</span>
          <span className="mt-0.5 block truncate font-mono text-[11px] leading-tight text-muted-foreground">{model}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-[248px]">
        {ok ? (
          <dl className="px-2 pt-1.5 pb-2 text-[12px]">
            {rows.map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-3 py-[3px]">
                <dt className="shrink-0 text-muted-foreground">{r.label}</dt>
                <dd className={cn("min-w-0 truncate text-right", r.mono && "font-mono text-[11px]")} title={r.value}>
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">
            {error ? `${error}. Запустите: docker compose up` : "Проверяю API…"}
          </p>
        )}
        <DropdownMenuItem onClick={load} closeOnClick={false}>
          <RefreshCw /> Проверить ещё раз
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {THEMES.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem key={value} onClick={() => setTheme(value)} closeOnClick={false}>
            <Icon /> {label}
            {theme === value && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------- Сайдбар ----------

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
  const { desktop, setSidebarOpen, openPalette } = useShell();
  const newChat = (
    <>
      <SquarePen className={ICON} />
      <span className="flex-1 text-left">Новый диалог</span>
      <Shortcut keys={["mod", "shift", "O"]} />
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-3">
        <Link
          href="/playground"
          className="min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
                  className="ml-auto size-7 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                  onClick={() => setSidebarOpen(false)}
                  aria-label="Скрыть боковую панель"
                />
              }
            >
              <PanelLeft />
            </TooltipTrigger>
            <TooltipContent>
              Скрыть панель <Shortcut keys={["mod", "B"]} className="ml-1" />
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="shrink-0 space-y-px px-2 pt-1">
        {onNew ? (
          <button
            type="button"
            className={SIDEBAR_ITEM}
            onClick={() => {
              onNew();
              onNavigate?.();
            }}
          >
            {newChat}
          </button>
        ) : (
          <Link href="/playground?new=1" className={SIDEBAR_ITEM} onClick={onNavigate}>
            {newChat}
          </Link>
        )}
        <button
          type="button"
          className={SIDEBAR_ITEM}
          onClick={() => {
            onNavigate?.();
            openPalette();
          }}
        >
          <Search className={ICON} />
          <span className="flex-1 text-left">Поиск</span>
          <Shortcut keys={["mod", "K"]} />
        </button>
      </div>

      <nav className="mt-4 shrink-0 space-y-px px-2" aria-label="Разделы стенда">
        <SidebarLabel>Стенд</SidebarLabel>
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={pathname.startsWith(href) ? "page" : undefined}
            className={SIDEBAR_ITEM}
          >
            <Icon className={ICON} />
            {label}
          </Link>
        ))}
      </nav>

      <div className="mt-4 flex min-h-0 flex-1 flex-col">{children}</div>

      <div className="shrink-0 border-t border-sidebar-border p-2">
        <StandStatus />
      </div>
    </div>
  );
}

/**
 * Каркас как в Claude: слева одна панель (новый диалог, поиск ⌘K, разделы, недавние, статус стенда),
 * справа рабочая область. На широких экранах панель сворачивается (⌘B), на узких выезжает поверх.
 */
export function AppShell({
  sidebar,
  onNew,
  onSelectSession,
  children,
  wide,
}: {
  sidebar?: React.ReactNode;
  onNew?: () => void;
  /** Выбор диалога из палитры ⌘K; без него палитра ведёт на /playground?s=<id>. */
  onSelectSession?: (id: string) => void;
  children: React.ReactNode;
  /** Широкая панель — для дерева базы знаний с длинными названиями. */
  wide?: boolean;
}) {
  const width = wide ? 288 : 256;
  const desktop = useMediaQuery("(min-width: 1024px)", true);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const router = useRouter();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- настройка хранится в браузере
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  const sidebarOpen = desktop ? !collapsed : mobileOpen;
  const setSidebarOpen = useCallback(
    (open: boolean) => {
      if (desktop) {
        setCollapsed(!open);
        localStorage.setItem(COLLAPSE_KEY, open ? "0" : "1");
      } else setMobileOpen(open);
    },
    [desktop],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "k" && !e.shiftKey) {
        e.preventDefault();
        setPalette((v) => !v);
      } else if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        setSidebarOpen(!sidebarOpen);
      } else if (key === "o" && e.shiftKey) {
        e.preventDefault();
        if (onNew) onNew();
        else router.push("/playground?new=1");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNew, router, setSidebarOpen, sidebarOpen]);

  const state = useMemo(
    () => ({ desktop, sidebarOpen, setSidebarOpen, openPalette: () => setPalette(true) }),
    [desktop, sidebarOpen, setSidebarOpen],
  );

  return (
    <ShellContext.Provider value={state}>
      <div className="flex h-dvh min-h-0 w-full overflow-hidden">
        {desktop ? (
          <aside
            className={cn(
              // max-lg:hidden — до гидрации сервер рисует десктопную раскладку; на телефоне панель не мелькает.
              "h-full shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-[cubic-bezier(0.2,0,0,1)] max-lg:hidden",
              !sidebarOpen && "border-r-0",
            )}
            style={{ width: sidebarOpen ? width : 0 }}
            inert={!sidebarOpen}
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
        <main className="relative flex min-w-0 flex-1 flex-col bg-background">{children}</main>
      </div>
      <CommandDialog
        open={palette}
        onOpenChange={setPalette}
        title="Поиск и команды"
        description="Диалоги, документы базы знаний, разделы стенда и действия"
        className="top-[16vh] sm:max-w-[580px]"
      >
        {palette && (
          <Command className="rounded-none! bg-transparent p-1">
            <PaletteBody close={() => setPalette(false)} onNew={onNew} onSelectSession={onSelectSession} />
          </Command>
        )}
      </CommandDialog>
    </ShellContext.Provider>
  );
}

/** Верхняя строка рабочей области, 48px: кнопка панели (если скрыта), заголовок, действия справа. */
export function PageBar({
  title,
  subtitle,
  children,
  className,
}: {
  title?: React.ReactNode;
  /** Короткое пояснение рядом с заголовком, приглушённое. */
  subtitle?: React.ReactNode;
  /** Устарело: иконка раздела больше не рисуется (оставлено для совместимости). */
  icon?: React.ElementType;
  children?: React.ReactNode;
  className?: string;
}) {
  const { sidebarOpen, setSidebarOpen, desktop } = useShell();
  return (
    <div className={cn("flex h-12 shrink-0 items-center gap-2 px-3", className)}>
      {!sidebarOpen && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => setSidebarOpen(true)}
                aria-label="Показать боковую панель"
              />
            }
          >
            {desktop ? <PanelLeft /> : <Menu />}
          </TooltipTrigger>
          <TooltipContent>
            Показать панель <Shortcut keys={["mod", "B"]} className="ml-1" />
          </TooltipContent>
        </Tooltip>
      )}
      <div className="flex min-w-0 flex-1 items-baseline gap-2 pl-1">
        {typeof title === "string" ? <h1 className="truncate text-[14px] font-medium">{title}</h1> : title}
        {subtitle && <span className="hidden truncate text-[13px] text-muted-foreground md:inline">{subtitle}</span>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}

/** Заголовок группы в сайдбаре (Стенд, Недавние, Документы…). */
export function SidebarLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-7 items-center px-2 text-[12px] font-medium text-muted-foreground", className)}>
      {children}
    </div>
  );
}
