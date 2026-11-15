"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { usePathname } from "next/navigation";
import { ThemeProvider as NextThemes, useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Стенд в светлой и тёмной темах (решение владельца, ноябрь 2026), по умолчанию — как в системе.
 * Чат в виджете светлый всегда: он живёт на чужом сайте.
 */
const LIGHT_ONLY = false;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const forceLight = LIGHT_ONLY || pathname?.startsWith("/embed");
  return (
    <NextThemes
      attribute="class"
      defaultTheme={LIGHT_ONLY ? "light" : "system"}
      enableSystem={!LIGHT_ONLY}
      disableTransitionOnChange
      forcedTheme={forceLight ? "light" : undefined}
      storageKey="eb.theme"
    >
      {children}
    </NextThemes>
  );
}

const OPTIONS = [
  { value: "light", label: "Светлая тема", icon: Sun },
  { value: "dark", label: "Тёмная тема", icon: Moon },
  { value: "system", label: "Как в системе", icon: Monitor },
] as const;

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- тема известна только в браузере
  useEffect(() => setMounted(true), []);

  return (
    <div
      role="radiogroup"
      aria-label="Тема оформления"
      className={cn("inline-flex items-center gap-0.5 rounded-full bg-sidebar-accent p-0.5", className)}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
              active && "bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.12)] dark:bg-accent",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
