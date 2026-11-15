// Вход администратора на /settings: токен проверяет Go-API (под пределом частоты настроек — перебор
// упирается в него), после чего сервер Next ставит httpOnly-cookie. Сам токен в браузере не хранится.

import { ADMIN_HEADER, BACKEND, adminCookie, adminEnabled, backendHeaders, matchesAdminToken } from "@/lib/backend";

export async function POST(request: Request) {
  if (!adminEnabled()) {
    return Response.json({ error: "Вход администратора не настроен: EB_ADMIN_TOKEN не задан" }, { status: 403 });
  }
  const body = await request.json().catch(() => ({}));
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || token.length > 512) return Response.json({ error: "Введите токен администратора" }, { status: 400 });

  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND}/api/settings/login`, {
      method: "POST",
      headers: { ...backendHeaders(request), [ADMIN_HEADER]: token },
      body: "{}",
      cache: "no-store",
    });
  } catch {
    return Response.json({ error: "API не запущен" }, { status: 502 });
  }
  if (!upstream.ok) {
    const detail = await upstream.json().catch(() => ({}));
    const error = upstream.status === 401 ? "Неверный токен администратора" : detail.error || `API ответил ${upstream.status}`;
    return Response.json({ error }, { status: upstream.status });
  }
  // API принял токен, а сервер Next знает другой — сохранять потом всё равно будет нечем.
  if (!matchesAdminToken(token)) {
    return Response.json({ error: "EB_ADMIN_TOKEN у сервера Next и у API различается" }, { status: 500 });
  }
  return Response.json({ admin: true }, { headers: { "Set-Cookie": adminCookie(request) } });
}
