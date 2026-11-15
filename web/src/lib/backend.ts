// Только для сервера Next (route handlers): адрес Go-API, его токен и вход администратора.
// В браузер ничего отсюда не попадает — клиентский код ходит в /api/* (src/lib/api.ts).
import { createHmac, timingSafeEqual } from "node:crypto";

// На Vercel: EB_API_URL — публичный адрес службы api на Railway, EB_API_TOKEN — тот же секрет, что у api
// (docs/deploy.md). Локально оба можно не задавать: API на :8787 без токена.
export const BACKEND = (process.env.EB_API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const TOKEN = process.env.EB_API_TOKEN ?? "";

// EB_ADMIN_TOKEN — тот же секрет, что у api: с ним /settings меняет настройки RAG для всех.
// Пусто — глобальные настройки закрыты, страница работает песочницей.
// Короче 32 знаков — не токен, а пароль, который подбирают: такой вход не включается вовсе.
const ADMIN_TOKEN_MIN = 32;
const RAW_ADMIN_TOKEN = process.env.EB_ADMIN_TOKEN ?? "";
if (RAW_ADMIN_TOKEN && RAW_ADMIN_TOKEN.length < ADMIN_TOKEN_MIN) {
  console.warn(`EB_ADMIN_TOKEN короче ${ADMIN_TOKEN_MIN} знаков — вход администратора выключен`);
}
const ADMIN_TOKEN = RAW_ADMIN_TOKEN.length >= ADMIN_TOKEN_MIN ? RAW_ADMIN_TOKEN : "";
export const ADMIN_HEADER = "X-Admin-Token";
const ADMIN_COOKIE = "eb_admin";
const ADMIN_TTL_SEC = 12 * 60 * 60;

/** Адрес посетителя: API считает по нему пределы частоты. Без него все посетители — один адрес Vercel. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "";
}

/** Заголовки запроса к Go-API: токен прокси и адрес посетителя. */
export function backendHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const ip = clientIp(request);
  if (ip) headers["X-Client-IP"] = ip;
  return headers;
}

export const adminEnabled = () => ADMIN_TOKEN.length > 0;

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Значение cookie администратора. В cookie лежит не сам токен, а его HMAC: утёкшая cookie не раскрывает
 * секрет API, а смена EB_ADMIN_TOKEN сразу выводит из всех сессий.
 */
function adminSession(): string {
  return createHmac("sha256", ADMIN_TOKEN).update("eb-admin-session:v1").digest("hex");
}

function readCookie(request: Request, name: string): string {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

/** Вошёл ли посетитель как администратор (cookie из /api/admin/login). */
export function isAdmin(request: Request): boolean {
  if (!adminEnabled()) return false;
  const got = readCookie(request, ADMIN_COOKIE);
  return !!got && sameSecret(got, adminSession());
}

/** Заголовки для глобальных настроек: токен администратора знает только сервер Next. */
export function adminHeaders(): Record<string, string> {
  return { [ADMIN_HEADER]: ADMIN_TOKEN };
}

function secure(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

/** Set-Cookie входа: httpOnly — скрипты страницы её не видят; SameSite=Strict — чужой сайт её не пошлёт. */
export function adminCookie(request: Request): string {
  return [
    `${ADMIN_COOKIE}=${adminSession()}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${ADMIN_TTL_SEC}`,
    ...(secure(request) ? ["Secure"] : []),
  ].join("; ");
}

export function clearAdminCookie(request: Request): string {
  return [`${ADMIN_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", ...(secure(request) ? ["Secure"] : [])].join(
    "; ",
  );
}

/** Совпадает ли введённый токен с токеном сервера Next. */
export function matchesAdminToken(token: string): boolean {
  return adminEnabled() && sameSecret(token, ADMIN_TOKEN);
}
