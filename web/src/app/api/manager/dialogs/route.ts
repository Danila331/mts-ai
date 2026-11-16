// Список диалогов для экрана менеджера: все разговоры клиентов, с заявкой и без. Токен менеджера подставляет сервер.

import { connection } from "next/server";
import { managerProxy } from "@/lib/manager-proxy";

export async function GET(request: Request) {
  await connection();
  const incoming = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const key of ["limit", "offset"]) {
    const value = incoming.get(key);
    if (value !== null) query.set(key, value);
  }
  const qs = query.toString();
  return managerProxy(request, `/api/sessions${qs ? `?${qs}` : ""}`);
}
