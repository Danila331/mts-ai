import { type LeadGrade, type LeadStatus, GRADE_TONE, STATUS_TONE } from "@/lib/manager";
import { cn } from "@/lib/utils";

const BASE = "inline-flex h-5 items-center rounded-4xl px-2 text-[11px] font-medium whitespace-nowrap";

/** Оценка заявки: горячая, тёплая, холодная; у старых заявок оценки нет. */
export function GradeBadge({ grade, label }: { grade: LeadGrade; label: string }) {
  if (!grade) return <span className={cn(BASE, "border text-muted-foreground")}>Без оценки</span>;
  return <span className={cn(BASE, GRADE_TONE[grade])}>{label}</span>;
}

export function KindBadge({ label }: { label: string }) {
  return <span className={cn(BASE, "border text-foreground")}>{label}</span>;
}

export function StatusBadge({ status, label }: { status: LeadStatus; label: string }) {
  return <span className={cn(BASE, STATUS_TONE[status])}>{label}</span>;
}
