import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { pageHeaders } from "@/lib/security-headers";

// Заголовки frame-ancestors (T35). Выполняется на каждый запрос страницы и читает EB_EMBED_ALLOWED_ORIGINS при
// запуске сервера, а не при сборке: next.config.ts headers() эту переменную «запёк» бы в образ.
//   /embed — frame-ancestors 'self' + allowlist (пусто — только локальные стенды);
//   остальные страницы — frame-ancestors 'none' и X-Frame-Options: DENY.
export function proxy(request: NextRequest) {
  const response = NextResponse.next();
  for (const [key, value] of Object.entries(pageHeaders(request.nextUrl.pathname, process.env.EB_EMBED_ALLOWED_ORIGINS))) {
    response.headers.set(key, value);
  }
  return response;
}

// Страницы, а не API, служебные файлы Next и статика (widget.js, значки): им iframe не страшен, а вызов прокси на
// каждом пикселе стоит времени.
export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)"],
};
