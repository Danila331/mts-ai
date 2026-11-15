// Только для сервера Next: пересылка запросов экрана менеджера в Go-API с токеном менеджера (T5).
// Отдельные обработчики, а не общий прокси src/app/api/[...path]: тот токен менеджера не знает и знать не должен.

import { BACKEND, managerEnabled, managerHeaders } from "@/lib/backend";

export const MANAGER_SETUP_ERROR =
  "Не задан EB_MANAGER_TOKEN. Задайте одно и то же значение для служб web и api (compose.yaml, docs/deploy.md) и перезапустите стенд.";

/** Ответ Go-API как есть (JSON и код); без токена менеджера — 503 с пояснением, что задать. */
export async function managerProxy(request: Request, path: string, init: { method?: string; body?: string } = {}) {
  if (!managerEnabled()) {
    return Response.json({ error: MANAGER_SETUP_ERROR, setup: true }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND}${path}`, {
      method: init.method ?? "GET",
      headers: managerHeaders(request),
      body: init.body,
      signal: request.signal,
      cache: "no-store",
    });
  } catch {
    return Response.json({ error: "API недоступен — запустите: docker compose up" }, { status: 502 });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" },
  });
}

/** Номер заявки: десять шестнадцатеричных знаков; шире не пускаем, чтобы не собирать произвольный путь. */
export const LEAD_CODE = /^[0-9a-f]{6,32}$/;
