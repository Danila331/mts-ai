// Смена статуса заявки (T5): new | in_progress | done | rejected. Допустимое значение проверяет Go-API.

import { connection } from "next/server";
import { LEAD_CODE, managerProxy } from "@/lib/manager-proxy";

export async function PATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  await connection();
  const { code } = await params;
  if (!LEAD_CODE.test(code)) return Response.json({ error: "not found" }, { status: 404 });
  return managerProxy(request, `/api/leads/${code}/status`, { method: "PATCH", body: await request.text() });
}
