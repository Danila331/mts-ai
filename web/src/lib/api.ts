import type { AnswerPayload, ChatMode, Health, KbData, RagSettings, Retrieval, SettingValue, Turn } from "./types";

// Все запросы идут на тот же origin (/api/* проксируется в Python-API), поэтому работает и внутри iframe виджета.
const BASE = "/api";

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const res = await fetch(`${BASE}/health`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`API недоступен (${res.status})`);
  return res.json();
}

let kbPromise: Promise<KbData> | null = null;

/** База знаний не меняется во время работы стенда — грузим один раз на вкладку. */
export function getKb(): Promise<KbData> {
  kbPromise ??= fetch(`${BASE}/kb`).then((res) => {
    if (!res.ok) throw new Error(`База знаний недоступна (${res.status})`);
    return res.json();
  });
  kbPromise.catch(() => (kbPromise = null));
  return kbPromise;
}

export interface StreamHandlers {
  onRetrieval?: (r: Retrieval & { ms?: number }) => void;
  onGeneration?: () => void;
  onAnswer: (a: AnswerPayload) => void;
}

/**
 * POST /api/chat отдаёт SSE: stage(retrieval) → stage(generation) → answer → done.
 * overrides — настройки песочницы (src/lib/sandbox.ts): действуют только на этот ответ.
 */
export async function streamChat(
  messages: Turn[],
  mode: ChatMode,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  overrides?: Record<string, SettingValue>,
): Promise<void> {
  const body = overrides && Object.keys(overrides).length ? { messages, mode, overrides } : { messages, mode };
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Ошибка API (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let answered = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === "stage" && payload.name === "retrieval") handlers.onRetrieval?.(payload);
      else if (event === "stage" && payload.name === "generation") handlers.onGeneration?.();
      else if (event === "answer") {
        answered = true;
        handlers.onAnswer(payload);
      } else if (event === "error") throw new Error(payload.error || "Ошибка ответа");
    }
  }
  if (!answered) throw new Error("Соединение оборвалось до ответа");
}

export async function sendLead(body: {
  name: string;
  phone: string;
  company: string;
  comment: string;
  messages: Turn[];
}): Promise<{ id: string; summary: string }> {
  const res = await fetch(`${BASE}/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Не удалось отправить заявку");
  return res.json();
}

export async function sendFeedback(body: {
  session_id: string;
  message_id: string;
  rating: 1 | -1;
  comment?: string;
  question?: string;
  answer?: string;
}): Promise<void> {
  await fetch(`${BASE}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function settingsJson(res: Response): Promise<RagSettings> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `API ответил ${res.status}`);
  return data as RagSettings;
}

/** Настройки RAG ядра: текущие, из окружения и пределы. */
export async function getSettings(): Promise<RagSettings> {
  return settingsJson(await fetch(`${BASE}/settings`, { cache: "no-store" }));
}

/** Сохранить настройки — глобально, для всех ответов стенда до перезапуска ядра. Только администратор. */
export async function saveSettings(values: Record<string, SettingValue>): Promise<RagSettings> {
  return settingsJson(
    await fetch(`${BASE}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }),
  );
}

/** Вернуть значения из окружения ядра. */
export async function resetSettings(): Promise<RagSettings> {
  return settingsJson(await fetch(`${BASE}/settings/reset`, { method: "POST" }));
}

export interface AdminSession {
  /** Задан ли EB_ADMIN_TOKEN: можно ли вообще войти. */
  enabled: boolean;
  admin: boolean;
}

/** Вошёл ли посетитель как администратор стенда (httpOnly-cookie видит только сервер). */
export async function getAdminSession(): Promise<AdminSession> {
  const res = await fetch(`${BASE}/admin/session`, { cache: "no-store" });
  if (!res.ok) return { enabled: false, admin: false };
  return res.json();
}

export async function adminLogin(token: string): Promise<void> {
  const res = await fetch(`${BASE}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `Вход не удался (${res.status})`);
  }
}

export async function adminLogout(): Promise<void> {
  await fetch(`${BASE}/admin/logout`, { method: "POST" });
}
