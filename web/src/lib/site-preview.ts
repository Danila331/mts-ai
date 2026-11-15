/**
 * Состояние превью «Сайт МТС» на /widget: чистая логика без React, чтобы её можно было проверить тестами.
 *
 * probing → (probeOk) → loading → (loaded) → ready
 *         ↘ (probeFail / loadTimeout) → failed(reason) → (retry) → probing
 */

export type PreviewPhase = "probing" | "loading" | "ready" | "failed";
export type FailReason = "down" | "timeout" | "mixed";

export interface PreviewState {
  phase: PreviewPhase;
  reason: FailReason | null;
}

export type PreviewEvent =
  | { type: "probeOk" }
  | { type: "probeFail"; reason: FailReason }
  | { type: "loaded" }
  | { type: "loadTimeout" }
  | { type: "retry" };

export const PROBE_TIMEOUT_MS = 4000;
export const LOAD_TIMEOUT_MS = 15000;

export const initialPreview: PreviewState = { phase: "probing", reason: null };

export function previewReducer(state: PreviewState, ev: PreviewEvent): PreviewState {
  switch (ev.type) {
    case "retry":
      return initialPreview;
    case "probeOk":
      // Поздний ответ проверки не должен затирать уже наступивший исход.
      return state.phase === "probing" ? { phase: "loading", reason: null } : state;
    case "probeFail":
      return state.phase === "probing" ? { phase: "failed", reason: ev.reason } : state;
    case "loaded":
      return state.phase === "loading" ? { phase: "ready", reason: null } : state;
    case "loadTimeout":
      return state.phase === "loading" || state.phase === "ready" ? { phase: "failed", reason: "timeout" } : state;
  }
}

/** Страница на https не может встроить http-iframe (смешанное содержимое), кроме localhost. */
export function isMixedContent(pageProtocol: string, standUrl: string): boolean {
  if (pageProtocol !== "https:") return false;
  try {
    const u = new URL(standUrl);
    if (u.protocol !== "http:") return false;
    return !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Достижим ли адрес: ответ любого статуса считается «жив», сетевая ошибка и тайм-аут — нет. */
export async function probeStand(
  url: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetcher(url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function failMessage(reason: FailReason | null): string {
  switch (reason) {
    case "mixed":
      return "Копия сайта МТС работает по http, а эта страница — по https: браузер её не покажет. Нужен https-адрес стенда (EB_STAND_URL).";
    case "timeout":
      return "Копия сайта МТС слишком долго отвечает.";
    default:
      return "Копия сайта МТС не запущена или недоступна.";
  }
}

/** Короткая подпись статуса для строки «Копия сайта МТС». */
export function standLabel(state: PreviewState): string {
  if (state.phase === "probing") return "проверяю…";
  if (state.phase !== "failed") return "запущена";
  return state.reason === "timeout" ? "не отвечает" : state.reason === "mixed" ? "нужен https" : "не запущена";
}

/** Размер файла в КБ с одним знаком и русской запятой: 4,9 КБ. */
export function formatKb(bytes: number): string {
  return `${(Math.round((bytes / 1024) * 10) / 10).toString().replace(".", ",")} КБ`;
}
