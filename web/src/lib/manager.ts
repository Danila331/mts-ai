// Экран менеджера (T5): типы ответов Go-API (GET /api/leads, /api/leads/:code), запросы через серверные обработчики
// /api/manager/* (токен менеджера подставляет сервер Next, в браузере его нет) и чистая логика списка.

import { humanizeCallbackLabel } from "./callback.ts";
import type { LeadKind } from "./lead-kinds";
import type { Passport, PassportGroup } from "./types";

export type LeadStatus = "new" | "in_progress" | "done" | "rejected";
export type LeadGrade = "hot" | "warm" | "cold" | "";

export interface StatusInfo {
  status: LeadStatus;
  label: string;
}

export interface LeadItem {
  code: string;
  created_at: string;
  name: string;
  company: string;
  kind: LeadKind;
  kind_label: string;
  grade: LeadGrade;
  grade_label: string;
  status: LeadStatus;
  status_label: string;
  product: PassportGroup;
  product_label: string;
}

export interface LeadList {
  items: LeadItem[];
  total: number;
  statuses: StatusInfo[];
}

export interface LeadScore {
  grade: LeadGrade;
  points: number;
  reasons: string[];
  /** Что спросить на звонке. */
  missing: string[];
  product: PassportGroup;
}

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
  answer_id?: string;
  /** id разделов базы, на которые опирался ответ. */
  sources?: string[];
  fallback?: boolean;
  at: string;
}

export interface LeadCard extends LeadItem {
  id: string;
  phone: string;
  comment: string;
  summary: string;
  summary_source: "digest" | "llm";
  callback: { time?: string; timezone?: string };
  callback_label: string;
  /** Паспорт на момент отправки; пустой объект — заявка без паспорта. */
  passport: Partial<Passport>;
  score: LeadScore;
  session_id?: string;
  /** Диалог на момент отправки: остаётся, даже когда сессию удалили по сроку хранения. */
  messages: { role: string; content: string }[];
  status_changed_at?: string;
  history: { session: { channel: string; title: string }; turns: HistoryTurn[] } | null;
}

/**
 * Удобное время для менеджера: выбор клиента в форме заявки, а если он ничего не выбрал — его собственные слова из
 * переписки (поле паспорта «Удобное время для звонка»: «звоните завтра после 14:00»). Иначе менеджер видел «не
 * указано», хотя клиент время назвал (ручной прогон). Это пожелание, а не договорённость — подпись рядом это говорит.
 */
export function callbackWish(card: Pick<LeadCard, "callback_label" | "passport">): string {
  if (card.callback_label) return humanizeCallbackLabel(card.callback_label);
  const said = card.passport.fields?.find((f) => f.key === "callback_preference")?.value?.trim();
  return said ? `«${said}» — из переписки` : "";
}

/** Ошибка запроса к экрану менеджера; setup — не задан EB_MANAGER_TOKEN. */
export class ManagerError extends Error {
  setup: boolean;
  constructor(message: string, setup = false) {
    super(message);
    this.setup = setup;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/manager${path}`, { cache: "no-store", ...init });
  } catch {
    throw new ManagerError("Нет связи со стендом");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; setup?: boolean };
  if (!res.ok) throw new ManagerError(body.error ?? `Ошибка ${res.status}`, body.setup === true);
  return body as T;
}

export const getLeads = (limit = 100, signal?: AbortSignal) => call<LeadList>(`/leads?limit=${limit}`, { signal });
export const getLead = (code: string, signal?: AbortSignal) => call<LeadCard>(`/leads/${code}`, { signal });
export const setLeadStatus = (code: string, status: LeadStatus) =>
  call<{ status: LeadStatus; status_label: string }>(`/leads/${code}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });

/** Период опроса списка: на демо заявка «прилетает» за несколько секунд. */
export const POLL_MS = 10_000;
/** Сколько новая заявка остаётся подсвеченной, если её не открыли. */
export const FRESH_MS = 20_000;

/**
 * Номера заявок, которых не было в прошлом ответе. Первая загрузка (prev === null) ничего не подсвечивает:
 * иначе при открытии страницы «новой» оказалась бы вся таблица.
 */
export function newCodes(prev: ReadonlySet<string> | null, items: readonly Pick<LeadItem, "code">[]): string[] {
  if (prev === null) return [];
  return items.filter((i) => !prev.has(i.code)).map((i) => i.code);
}

/** Заявки по убыванию времени создания — порядок списка, даже если API отдаст иначе. */
export function newestFirst<T extends Pick<LeadItem, "created_at">>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** «5 мин назад» — для списка; точное время — в подсказке. */
export function ago(iso: string, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 45) return "только что";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн назад`;
}

/** «ждёт 5 мин» — сколько заявка лежит без ответа менеджера. */
export function waiting(iso: string, now = Date.now()): string {
  const text = ago(iso, now);
  return text === "только что" ? "ждёт меньше минуты" : `ждёт ${text.replace(" назад", "")}`;
}

export const GRADE_TONE: Record<Exclude<LeadGrade, "">, string> = {
  hot: "bg-tone-danger text-white",
  warm: "bg-tone-warning text-white",
  cold: "bg-tone-info text-white",
};

export const STATUS_TONE: Record<LeadStatus, string> = {
  new: "bg-primary text-white",
  in_progress: "bg-tone-info text-white",
  done: "bg-tone-success text-white",
  rejected: "bg-muted-foreground text-white",
};

export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "Новая",
  in_progress: "В работе",
  done: "Закрыта",
  rejected: "Нецелевая",
};

/** Пустые строки списка вместо «undefined»: у старых заявок нет ни компании, ни имени. */
export const leadTitle = (l: Pick<LeadItem, "company" | "name">) => l.company || l.name || "Без названия";

/**
 * Телефон для показа и копирования: «+79000000000» → «+7 900 000-00-00». Российский номер (11 цифр, 7 или 8
 * в начале) форматируется, остальное возвращается как есть: чужой формат не угадываем.
 */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const ru = digits.length === 11 && (digits[0] === "7" || digits[0] === "8") ? digits.slice(1) : digits.length === 10 ? digits : "";
  if (!ru) return raw.trim();
  return `+7 ${ru.slice(0, 3)} ${ru.slice(3, 6)}-${ru.slice(6, 8)}-${ru.slice(8)}`;
}
