/**
 * Антибот формы заявки без CAPTCHA (T35): скрытая ловушка и минимальное время заполнения.
 * Тот же порог проверяет Go-API (EB_LEAD_MIN_FILL, backend/internal/transport/http/antibot.go).
 */

/** Быстрее этого заявку сервер не примет. */
export const MIN_FILL_MS = 2000;

/** Имя скрытого поля. Выглядит как нужное боту, человек его не видит. */
export const HONEYPOT_FIELD = "website";

/** Сколько ещё подождать до порога; 0 — порог пройден. */
export function remainingMs(shownAt: number, now: number, min = MIN_FILL_MS): number {
  return Math.max(0, min - Math.max(0, now - shownAt));
}

/** Сколько форма была на экране (для сервера), не меньше нуля. */
export function elapsedMs(shownAt: number, now: number): number {
  return Math.max(0, Math.round(now - shownAt));
}

/** Стили скрытого поля: не display:none (часть ботов такие пропускает), а за краем экрана. */
export const HONEYPOT_STYLE = {
  position: "absolute",
  left: "-10000px",
  top: "auto",
  width: "1px",
  height: "1px",
  overflow: "hidden",
} as const;
