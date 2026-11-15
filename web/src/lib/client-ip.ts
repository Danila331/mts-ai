/**
 * Адрес посетителя для пределов частоты (T35). Чистая логика прокси Next (src/lib/backend.ts).
 *
 * X-Forwarded-For ставит платформа (Vercel, nginx) — но только если перед Next есть платформа. Локально и в
 * docker compose перед Next прокси нет, и заголовок задаёт сам клиент: тогда любой обходит предел, подставляя
 * новый адрес в каждом запросе. Поэтому доверие настраивается EB_TRUST_PROXY_HEADERS:
 *   1 / true / yes — доверять (за своим nginx, балансировщиком);
 *   0 / false / no — не доверять никогда;
 *   не задано      — доверять только на Vercel (платформа ставит VERCEL=1 и перезаписывает заголовок).
 * Без доверия Next адрес не передаёт, и Go-API считает предел по адресу соединения.
 */
import { isIP } from "node:net";

type Env = Record<string, string | undefined>;

export function trustProxyHeaders(env: Env): boolean {
  const flag = (env.EB_TRUST_PROXY_HEADERS ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(flag)) return true;
  if (["0", "false", "no", "off"].includes(flag)) return false;
  return !!env.VERCEL;
}

/** Первый адрес из X-Forwarded-For — клиент; дальше идут прокси. Только настоящий IP, не произвольная строка. */
export function firstAddress(header: string | null | undefined): string {
  const first = (header ?? "").split(",")[0]?.trim() ?? "";
  return isIP(first) ? first : "";
}

export function clientIpFrom(get: (name: string) => string | null, env: Env): string {
  if (!trustProxyHeaders(env)) return "";
  return firstAddress(get("x-forwarded-for")) || firstAddress(get("x-real-ip"));
}
