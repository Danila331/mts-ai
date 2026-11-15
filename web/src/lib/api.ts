import type { CallbackPreference } from "./callback";
import type { LeadKind } from "./lead-kinds";
import type { PageInfo } from "./page-context";
import type { RoleId, RoleSource } from "./roles";
import type {
  AnswerPayload,
  ChatMode,
  Health,
  KbData,
  OcrInfo,
  OcrResult,
  Passport,
  RagSettings,
  Retrieval,
  SettingValue,
  Turn,
} from "./types";

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

const OCR_OFF: OcrInfo = { enabled: false, photos: false, pdf: false, types: [], max_bytes: 0, max_pages: 0 };
let ocrPromise: Promise<OcrInfo> | null = null;

/** Что принимается из документов (T9). Не меняется во время работы стенда — один запрос на вкладку;
 * API недоступен — кнопки вложения нет, следующий вызов спросит снова. */
export function getOcrInfo(): Promise<OcrInfo> {
  ocrPromise ??= fetch(`${BASE}/ocr`, { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<OcrInfo>) : Promise.reject(new Error(String(res.status)))))
    .catch(() => {
      ocrPromise = null;
      return OCR_OFF;
    });
  return ocrPromise;
}

/** Документ → текст на проверку клиенту. Тело — сам файл: сервер проверяет его сигнатуру и ничего не хранит. */
export async function readDocument(file: Blob, type: string, signal?: AbortSignal): Promise<OcrResult> {
  const res = await fetch(`${BASE}/ocr`, {
    method: "POST",
    headers: { "Content-Type": type || "application/octet-stream" },
    body: file,
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error) throw new Error(data.error);
    throw new Error(res.status === 413 ? "Файл слишком большой" : `Не удалось распознать документ (${res.status})`);
  }
  return data as OcrResult;
}

export interface StreamHandlers {
  onRetrieval?: (r: Retrieval & { ms?: number }) => void;
  onGeneration?: () => void;
  /** Кусок ответа по мере генерации (T13). Без обработчика дельты пропускаются — ответ придёт целиком в onAnswer. */
  onDelta?: (text: string) => void;
  /** Готовый ответ. Главнее дельт: проверка могла переписать напечатанное. */
  onAnswer: (a: AnswerPayload) => void;
  /** Паспорт задачи после ответа (режим chat с сессией). */
  onPassport?: (p: Passport) => void;
}

/** Откуда разговор: стенд или виджет на сайте. Сервер хранит сессию с этим каналом. */
export type Channel = "playground" | "embed";

export interface ChatOptions {
  signal?: AbortSignal;
  /** Настройки песочницы (src/lib/sandbox.ts): действуют только на этот ответ. */
  overrides?: Record<string, SettingValue>;
  /** id разговора на фронте: сервер собирает по нему историю сессии для менеджера. */
  sessionId?: string;
  channel?: Channel;
  /** Страница сайта, где открыт виджет (путь, заголовок, UTM): пишется в сессию для аналитики, в промпт не идёт. */
  page?: PageInfo;
  /**
   * Роль-подсказка (T15) и откуда она: client — выбрал кнопкой (пустая роль — снял), auto — определил фронт.
   * Без источника не отправляется: сервер определит роль сам. В промпт попадает только в режиме chat.
   */
  role?: RoleId | "";
  roleSource?: RoleSource;
}

/** POST /api/chat отдаёт SSE: stage(retrieval) → stage(generation) → delta… → answer → passport → done. */
export async function streamChat(
  messages: Turn[],
  mode: ChatMode,
  handlers: StreamHandlers,
  { signal, overrides, sessionId, channel, page, role, roleSource }: ChatOptions = {},
): Promise<void> {
  const body: Record<string, unknown> = { messages, mode };
  if (overrides && Object.keys(overrides).length) body.overrides = overrides;
  if (mode === "chat" && roleSource) Object.assign(body, { role: role ?? "", role_source: roleSource });
  if (sessionId) {
    Object.assign(body, { session_id: sessionId, channel: channel ?? "playground" });
    if (page && Object.keys(page).length) body.page = page;
  }
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
      else if (event === "delta") {
        if (!answered && typeof payload.text === "string") handlers.onDelta?.(payload.text);
      } else if (event === "answer") {
        answered = true;
        handlers.onAnswer(payload);
      } else if (event === "passport") handlers.onPassport?.(payload);
      else if (event === "error") throw new Error(payload.error || "Ошибка ответа");
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
  /** Разговор: заявка возьмёт его паспорт задачи с сервера. */
  session_id?: string;
  /** Удобное время звонка (T4): часть дня и часовой пояс — пожелание, а не запись на время. */
  callback?: CallbackPreference;
  /** Тип заявки (T17); без него — обратный звонок. */
  kind?: LeadKind;
  /** Согласие на обработку персональных данных — на том же шаге, что и контакты. */
  consent: boolean;
}): Promise<{ id: string; summary: string; kind?: LeadKind }> {
  const res = await fetch(`${BASE}/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || "Не удалось отправить заявку");
  }
  return res.json();
}

/** Клиент правит паспорт задачи: строка — новое значение, null — стереть поле. */
export async function patchPassport(sessionId: string, values: Record<string, string | null>): Promise<Passport> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/passport`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Не удалось сохранить");
  return data as Passport;
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
