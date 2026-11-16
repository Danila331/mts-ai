/**
 * Кто может встроить /embed и кому верить в postMessage (T35).
 *
 * Чистый модуль без импортов: его собирают и загрузчик виджета (widget/loader.ts → public/widget.js), и /embed,
 * и прокси заголовков (src/proxy.ts); тесты запускает `node --test` без сборки.
 *
 * Два уровня защиты:
 *  1. Заголовок `Content-Security-Policy: frame-ancestors` на /embed — браузер не покажет страницу в окне чужого
 *     сайта вообще (embedFrameAncestors). Это граница доверия.
 *  2. Сообщения eb:* — точный targetOrigin при отправке и строгая проверка отправителя при получении
 *     (isTrustedMessage): origin совпадает, а окно — ровно то, которое мы ждём (родитель или наш iframe).
 *
 * Allowlist — EB_EMBED_ALLOWED_ORIGINS: origin'ы через запятую или пробел, без путей и без масок.
 */

/** Приводит запись allowlist к origin; не http(s), с путём, логином, маской или мусором — null. */
export function toOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.includes("*")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  return url.origin;
}

/** Allowlist из переменной окружения: годные origin'ы без повторов, негодные записи молча отбрасываются. */
export function parseOrigins(raw: string | undefined | null): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[\s,]+/)) {
    const origin = toOrigin(part);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/** Локальный стенд разработчика: localhost, 127.0.0.1, [::1] и *.localhost. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Источники, которым разрешено встраивать локально (пустой allowlist): любые порты локального стенда. Без [::1]:
 * грамматика CSP не знает IPv6-адресов, и Chrome отбрасывал источник с ошибкой в консоли на каждой странице.
 */
export const LOCAL_ANCESTORS = ["http://localhost:*", "http://127.0.0.1:*", "http://*.localhost:*"];

/**
 * Значение frame-ancestors для /embed. Свой origin всегда; allowlist — если задан; пустой allowlist — только
 * локальные стенды, а не «любой сайт».
 */
export function embedFrameAncestors(allowed: string[]): string {
  const sources = allowed.length ? allowed : LOCAL_ANCESTORS;
  return `frame-ancestors 'self' ${sources.join(" ")}`;
}

/** Остальные страницы не встраивает никто. */
export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

/**
 * Хозяин /embed: origin из `?parent=` принимается, только если ему можно доверять.
 *
 * - `param` — значение ?parent= (его пишет загрузчик, но подставить может кто угодно);
 * - `allowed` — EB_EMBED_ALLOWED_ORIGINS; пусто — только свой origin и локальные стенды;
 * - `ancestor` — `location.ancestorOrigins[0]`, где браузер его даёт (Chrome, Safari): настоящий хозяин окна,
 *   подделать его страница не может; в Firefox его нет;
 * - `self` — origin самого /embed.
 *
 * null — хозяину не доверяем: сообщения ему не шлём и от него не принимаем.
 */
export function resolveParent(
  param: string | null | undefined,
  allowed: string[],
  ancestor: string | null | undefined,
  self: string,
): string | null {
  const origin = param ? toOrigin(param) : null;
  if (!origin) return null;
  if (ancestor && ancestor !== "null" && ancestor !== origin) return null;
  const permitted = allowed.length ? allowed.includes(origin) : isLocalOrigin(origin);
  return permitted || origin === self ? origin : null;
}

/**
 * Сообщению верим, только если оно пришло с ожидаемого origin и из ожидаемого окна. Одной проверки origin мало:
 * другое окно того же сайта (вторая вкладка, чужой iframe на странице) имеет тот же origin.
 */
export function isTrustedMessage(
  event: { origin: string; source: unknown },
  expectedOrigin: string | null | undefined,
  expectedSource: unknown,
): boolean {
  if (!expectedOrigin || expectedOrigin === "*" || expectedOrigin === "null") return false;
  if (!expectedSource || event.source !== expectedSource) return false;
  return event.origin === expectedOrigin;
}

/** Куда слать сообщение: точный origin, никогда «*». Для opaque origin («null», file://) слать некуда. */
export function targetOrigin(origin: string | null | undefined): string | null {
  return origin && origin !== "*" && origin !== "null" && toOrigin(origin) === origin ? origin : null;
}
