/**
 * Заголовки безопасности страниц (T35). Чистая логика для src/proxy.ts и тестов.
 *
 * Почему прокси, а не `headers()` в next.config.ts: headers() вычисляется при сборке (routes-manifest.json), а
 * EB_EMBED_ALLOWED_ORIGINS нужно читать при запуске — один образ ходит между стендами. proxy.ts (бывший
 * middleware, Next 16) выполняется на каждый запрос и видит process.env сервера. Постоянные заголовки без
 * окружения (nosniff, Referrer-Policy) остаются в next.config.ts.
 */
import { FRAME_ANCESTORS_NONE, embedFrameAncestors, parseOrigins } from "./embed-origin.ts";

/** /embed и всё под ним — страница, которую встраивают. */
export function isEmbedPath(pathname: string): boolean {
  return pathname === "/embed" || pathname.startsWith("/embed/");
}

/** Content-Security-Policy страницы: frame-ancestors по allowlist для /embed, 'none' для остальных. */
export function framePolicy(pathname: string, allowedRaw: string | undefined): string {
  return isEmbedPath(pathname) ? embedFrameAncestors(parseOrigins(allowedRaw)) : FRAME_ANCESTORS_NONE;
}

/** Заголовки ответа страницы. X-Frame-Options дублирует 'none' для старых браузеров; у /embed его нет. */
export function pageHeaders(pathname: string, allowedRaw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Content-Security-Policy": framePolicy(pathname, allowedRaw) };
  if (!isEmbedPath(pathname)) headers["X-Frame-Options"] = "DENY";
  return headers;
}

/** Постоянные заголовки для всех путей (next.config.ts headers()). */
export const STATIC_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // В /embed адрес хозяина приходит параметром ?parent=, а полный адрес страницы наружу не нужен никому.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];
