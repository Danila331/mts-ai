// Прокси на Go-API (backend/). Фронт и виджет ходят на свой origin, поэтому CORS не нужен,
// а адрес бэкенда и его токен знает только сервер Next. SSE пробрасывается потоком, без буферизации.
//
// На Vercel: EB_API_URL — публичный адрес службы api на Railway, EB_API_TOKEN — тот же секрет, что у api
// (docs/deploy.md). Локально оба можно не задавать: API на :8787 без токена.

const BACKEND = (process.env.EB_API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const TOKEN = process.env.EB_API_TOKEN ?? "";
// settings — глобальные настройки RAG (стенд для жюри: «Сохранить» меняет бота для всех).
const ALLOWED = new Set(["health", "kb", "chat", "lead", "feedback", "settings", "settings/reset"]);

// Ответ модели с перезапросами проверки занимает до пары минут, а функция Vercel живёт, пока идёт поток.
// Умолчания платформы на это не рассчитаны: без запаса длинный ответ обрывался бы на середине.
export const maxDuration = 300;

/** Адрес посетителя: API считает по нему пределы частоты. Без него все посетители — один адрес Vercel. */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "";
}

async function proxy(request: Request, params: Promise<{ path: string[] }>) {
  const { path } = await params;
  const name = path.join("/");
  if (!ALLOWED.has(name)) return Response.json({ error: "not found" }, { status: 404 });
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const ip = clientIp(request);
  if (ip) headers["X-Client-IP"] = ip;
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
  // База знаний меняется только с выкаткой ядра: отдаём её с края Vercel, а не гоняем каждый раз до Railway.
  // Свежесть держит stale-while-revalidate — новая версия базы подтянется в фоне.
  if (name === "kb" && request.method === "GET" && upstream.ok) {
    out.set("Cache-Control", "public, max-age=60, s-maxage=600, stale-while-revalidate=86400");
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, ctx.params);
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, ctx.params);
}
