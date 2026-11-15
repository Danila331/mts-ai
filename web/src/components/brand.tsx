import { cn } from "@/lib/utils";

/**
 * Знак EnergyTool AI: шкала прибора учёта со стрелкой — то, с чего начинается энергоучёт.
 * Красная плашка — цвет МТС; сам логотип МТС не воспроизводим.
 */
export function BrandMark({ className, round }: { className?: string; round?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center bg-brand text-white shadow-[inset_0_-1px_0_rgb(0_0_0/0.12),0_1px_2px_rgb(217_71_77/0.18)]",
        round ? "rounded-full" : "rounded-[9px]",
        className,
      )}
    >
      <svg viewBox="0 0 28 28" fill="none" className="size-[78%]">
        <path
          d="M7.42 19.39A7 7 0 1 1 20.58 19.39"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <path d="M14 17 17.6 12.7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="14" cy="17" r="1.7" fill="currentColor" />
      </svg>
    </span>
  );
}

/** Знак + название. */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <BrandMark className="size-7 rounded-[8px]" />
      <span className="truncate text-[16px] leading-none font-semibold tracking-[-0.02em]">
        EnergyTool<span className="ml-[3px] text-brand-text">AI</span>
      </span>
    </span>
  );
}

/**
 * Знак без плашки — как искра у Claude: шкала прибора в мягком красном.
 * live — стрелка качается маятником (строка «консультант думает»).
 */
export function BrandGlyph({ className, live }: { className?: string; live?: boolean }) {
  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden className={cn("shrink-0 text-brand", className)}>
      <path
        d="M7.42 19.39A7 7 0 1 1 20.58 19.39"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        className={live ? "opacity-35" : undefined}
      />
      <path
        d="M14 17 17.6 12.7"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        className={live ? "gauge-needle" : undefined}
      />
      <circle cx="14" cy="17" r="1.9" fill="currentColor" />
    </svg>
  );
}
