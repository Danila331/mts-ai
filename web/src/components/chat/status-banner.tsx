"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getHealth } from "@/lib/api";
import { statusBanner } from "@/lib/degraded";
import type { Health } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Как часто спрашиваем состояние, пока вкладка открыта: достаточно, чтобы баннер ушёл после перезапуска. */
const POLL_MS = 30_000;

/**
 * Баннер статуса (T30) над перепиской — на стенде и в виджете. Состояние — `/api/health` (тот же источник, что
 * у шапки стенда), показывается только при деградации и без технических деталей.
 */
export function StatusBanner({
  answerDegraded,
  compact,
  onLead,
  pollKey,
}: {
  answerDegraded?: boolean;
  /** Меняется с каждым новым ответом: пришёл ответ — ядро живо, состояние перепроверяем сразу, а не через 30 с. */
  pollKey?: string;
  compact?: boolean;
  /** Баннер обещает «заявку можно оставить уже сейчас» — значит, и кнопка заявки должна быть здесь же. */
  onLead?: () => void;
}) {
  const [health, setHealth] = useState<Health | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let alive = true;
    let ctrl: AbortController | null = null;
    const poll = () => {
      if (document.visibilityState === "hidden") return;
      ctrl?.abort();
      ctrl = new AbortController();
      getHealth(ctrl.signal)
        .then((h) => {
          if (!alive) return;
          setHealth(h);
          setUnreachable(false);
        })
        .catch((e: unknown) => {
          if (alive && !(e instanceof DOMException && e.name === "AbortError")) setUnreachable(true);
        });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      ctrl?.abort();
      clearInterval(timer);
    };
  }, [pollKey]);

  // Если опрос уже показал, что всё работает, а последний ответ пришёл без модели, — верим ответу: он свежее.
  const banner = statusBanner({ health, unreachable, answerDegraded });
  if (!banner) return null;
  const Icon = banner.tone === "danger" ? RefreshCw : AlertTriangle;
  return (
    <div
      role="status"
      className={cn(
        "sticky top-0 z-20 flex items-start gap-2.5 rounded-xl ring-1",
        compact ? "px-3 py-2 text-[12.5px]" : "px-3.5 py-2.5 text-[13.5px]",
        // Баннер прилипает к верху ленты — фон непрозрачный, иначе текст ответа просвечивает сквозь него.
        banner.tone === "danger"
          ? "bg-[color-mix(in_oklab,var(--destructive)_10%,var(--background))] ring-destructive/25"
          : "bg-warning-soft ring-tone-warning/25",
      )}
    >
      <Icon
        aria-hidden
        className={cn("mt-0.5 size-4 shrink-0", banner.tone === "danger" ? "text-destructive" : "text-tone-warning")}
      />
      <p className="leading-snug">
        <span className="font-medium">{banner.title}.</span>{" "}
        <span className="text-muted-foreground">{banner.text}</span>
        {onLead && (
          <>
            {" "}
            <button
              type="button"
              onClick={onLead}
              className="font-medium text-brand-text underline underline-offset-2 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              Оставить заявку
            </button>
          </>
        )}
      </p>
    </div>
  );
}
