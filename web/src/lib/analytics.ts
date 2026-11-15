// Аналитика менеджера (T6): типы ответа GET /api/analytics и чистая логика отображения.

import { ManagerError } from "./manager.ts";

export type Days = 7 | 30;
export const PERIODS: Days[] = [7, 30];

export interface Stage {
  key: string;
  label: string;
  count: number;
  /** Доля от числа сессий, 0..1. */
  share: number;
}

export interface Bucket {
  key: string;
  label: string;
  count: number;
}

export interface ChannelRow {
  key: string;
  label: string;
  sessions: number;
  leads: number;
}

export interface Gap {
  question: string;
  count: number;
  last_at: string;
}

export interface Report {
  days: Days;
  min_fields: number;
  funnel: Stage[];
  leads: number;
  by_grade: Bucket[];
  by_kind: Bucket[];
  by_channel: ChannelRow[];
  answers: number;
  fallbacks: number;
  gap_signal: "fallback";
  gaps: Gap[];
}

export async function getAnalytics(days: Days, signal?: AbortSignal): Promise<Report> {
  let res: Response;
  try {
    res = await fetch(`/api/manager/analytics?days=${days}`, { cache: "no-store", signal });
  } catch {
    throw new ManagerError("Нет связи со стендом");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; setup?: boolean };
  if (!res.ok) throw new ManagerError(body.error ?? `Ошибка ${res.status}`, body.setup === true);
  return body as unknown as Report;
}

/** «37%» — доля с округлением до целого процента; для пустого периода — прочерк. */
export const percent = (share: number, total = 1) => (total > 0 ? `${Math.round(share * 100)}%` : "—");

/** Сколько осталось от предыдущего шага воронки, «—» если предыдущий шаг пуст. */
export function stepKept(funnel: readonly Stage[], i: number): string {
  if (i === 0 || funnel[i - 1].count === 0) return "—";
  return `${Math.round((funnel[i].count / funnel[i - 1].count) * 100)}%`;
}

/** Ширина полосы в процентах от максимума; ненулевое значение всегда видно. */
export function barWidth(count: number, max: number): number {
  if (max <= 0 || count <= 0) return 0;
  return Math.max(2, Math.round((count / max) * 100));
}

/** Пробелы базы текстом — «скопировать для команды контента». Вопросы уже без телефонов и почты. */
export function gapsText(gaps: readonly Gap[], days: Days): string {
  if (gaps.length === 0) return "";
  const lines = gaps.map((g) => `${g.count} × ${g.question}`);
  return [`Вопросы, на которые бот дал запасной ответ (за ${days} дн.):`, ...lines].join("\n");
}
