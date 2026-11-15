// Состояние входа для страницы /settings: можно ли войти (задан ли EB_ADMIN_TOKEN) и вошёл ли посетитель.

import { connection } from "next/server";
import { adminEnabled, isAdmin } from "@/lib/backend";

export async function GET(request: Request) {
  // Только во время запроса: при сборке EB_ADMIN_TOKEN нет, и без этого Next запёк бы ответ «входа нет».
  await connection();
  return Response.json(
    { enabled: adminEnabled(), admin: isAdmin(request) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
