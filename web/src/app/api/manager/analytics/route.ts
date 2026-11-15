// Аналитика воронки и пробелов базы для экрана менеджера (T6): ?days=7|30. Допустимый период проверяет Go-API.

import { connection } from "next/server";
import { managerProxy } from "@/lib/manager-proxy";

export async function GET(request: Request) {
  await connection();
  const days = new URL(request.url).searchParams.get("days");
  return managerProxy(request, `/api/analytics${days !== null ? `?days=${encodeURIComponent(days)}` : ""}`);
}
