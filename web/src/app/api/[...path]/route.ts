// Прокси на Python-API (scripts/web_api.py). Фронт и виджет ходят на свой origin, поэтому CORS не нужен,
// а адрес бэкенда знает только сервер Next. SSE пробрасывается потоком, без буферизации.

const BACKEND = process.env.EB_API_URL ?? "http://127.0.0.1:8787";
const ALLOWED = new Set(["health", "kb", "chat", "lead", "feedback"]);

async function proxy(request: Request, params: Promise<{ path: string[] }>) {
  const { path } = await params;
  const name = path.join("/");
  if (!ALLOWED.has(name)) return Response.json({ error: "not found" }, { status: 404 });
  const init: RequestInit = {
    method: request.method,
    headers: { "Content-Type": "application/json" },
    signal: request.signal,
    cache: "no-store",
  };
  if (request.method === "POST") init.body = await request.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${BACKEND}/api/${name}`, init);
  } catch {
    return Response.json(
      { error: "Python-API не запущен: .venv/bin/python scripts/web_api.py" },
      { status: 502 },
    );
  }
  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
    "Cache-Control": "no-cache, no-transform",
  });
  if (name === "chat") headers.set("X-Accel-Buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers });
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, ctx.params);
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, ctx.params);
}
