"use client";

import { BookOpen, Code2, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getHealth } from "@/lib/api";
import type { Health } from "@/lib/types";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/playground", label: "Чат и отладка", icon: MessagesSquare },
  { href: "/kb", label: "База знаний", icon: BookOpen },
  { href: "/widget", label: "Виджет для сайта", icon: Code2 },
];

function HealthBadge() {
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs text-muted-foreground" />
        }
      >
        <span className={cn("size-2 rounded-full", ok ? (health.llm ? "bg-emerald-500" : "bg-amber-500") : "bg-red-500")} />
        {ok ? (health.llm ? health.model.split("/").pop() : "без модели") : "API недоступен"}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {ok ? (
          <div className="space-y-0.5 text-xs">
            <div>Модель: {health.llm ? health.model : "не настроена — ответы выдержкой из базы"}</div>
            <div>Поиск: BM25{health.dense ? " + эмбеддинги" : ""}{health.reranker ? " + реранкер" : ""}</div>
            <div>Схема ответа: {health.arch}</div>
            <div>База: {health.docs} документов, {health.chunks} разделов</div>
          </div>
        ) : (
          <span className="text-xs">{error || "Проверяю…"} Запустите: .venv/bin/python scripts/web_api.py</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function AppHeader() {
  const pathname = usePathname();
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b bg-background px-4">
      <Link href="/playground" className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-brand text-[10px] font-bold text-white">ET</span>
        <span className="text-sm font-semibold">
          EnergyTool <span className="font-normal text-muted-foreground">· ИИ-консультант</span>
        </span>
      </Link>
      <nav className="flex items-center gap-1">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground",
              pathname.startsWith(href) && "bg-muted font-medium text-foreground",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto">
        <HealthBadge />
      </div>
    </header>
  );
}
