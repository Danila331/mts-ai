// Прокси на Go-API (backend/). Фронт и виджет ходят на свой origin, поэтому CORS не нужен,
// а адрес бэкенда и его токен знает только сервер Next (src/lib/backend.ts). SSE пробрасывается потоком,
// без буферизации.

import { BACKEND, adminHeaders, backendHeaders, isAdmin } from "@/lib/backend";

const ALLOWED = new Set(["health", "kb", "chat", "lead", "feedback", "settings", "settings/reset"]);
// Менять настройки RAG для всех может только администратор, вошедший на /settings. Остальные получают
// песочницу: свои настройки уходят полем overrides в /api/chat и действуют только на их ответы.
const ADMIN_ONLY = new Set(["POST settings", "POST settings/reset"]);

// Ответ модели с перезапросами проверки занимает до пары минут, а функция Vercel живёт, пока идёт поток.
// Умолчания платформы на это не рассчитаны: без запаса длинный ответ обрывался бы на середине.
export const maxDuration = 300;

async function proxy(request: Request, params: Promise<{ path: string[] }>) {
  const { path } = await params;
  const name = path.join("/");
  if (!ALLOWED.has(name)) return Response.json({ error: "not found" }, { status: 404 });
  const headers = backendHeaders(request);
  if (ADMIN_ONLY.has(`${request.method} ${name}`)) {
    // Проверка здесь — чтобы не нести запрос дальше; Go-API проверяет токен ещё раз сам.
    if (!isAdmin(request)) {
      return Response.json({ error: "Глобальные настройки меняет только администратор стенда" }, { status: 401 });
    }
    Object.assign(headers, adminHeaders());
  }
  const init: RequestInit = { method: request.method, headers, signal: request.signal, cache: "no-store" };
  if (request.method === "POST") init.body = await request.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND}/api/${name}`, init);
  } catch {
    return Response.json(
      { error: "API не запущен: docker compose up (или make -C backend api)" },
      { status: 502 },
    );
  }
  const out = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
    "Cache-Control": "no-cache, no-transform",
  });
  if (name === "chat") out.set("X-Accel-Buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, ctx.params);
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, ctx.params);
}
