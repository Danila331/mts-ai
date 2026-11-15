"use client";

import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

/* Общие кирпичики документов-итогов: «Итоги консультации» (T10) и «Пакет для правления» (T22). */

export const dateTime = (ts: number) =>
  new Date(ts).toLocaleString("ru-RU", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function KbLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("inline-flex items-baseline gap-0.5 text-brand-text underline-offset-2 hover:underline", className)}
    >
      {children}
      <ArrowUpRight className="size-3 shrink-0 self-center print:hidden" aria-hidden />
    </a>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t pt-5 pb-1">
      <h2 className="mb-3 text-[18px] leading-snug font-semibold break-after-avoid">{title}</h2>
      {children}
    </section>
  );
}
