// Список заявок для экрана менеджера (T5): сервер сам подставляет токен менеджера.

import { connection } from "next/server";
import { managerProxy } from "@/lib/manager-proxy";

export async function GET(request: Request) {
  // Только во время запроса: при сборке EB_MANAGER_TOKEN нет.
  await connection();
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const key of ["limit", "offset", "status"]) {
    const value = incoming.get(key);
    if (value !== null) query.set(key, value);
  }
  const qs = query.toString();
  return managerProxy(request, `/api/leads${qs ? `?${qs}` : ""}`);
}
