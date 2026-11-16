// Диалог целиком: переписка по порядку, паспорт и номер заявки, если она есть.

import { connection } from "next/server";
import { DIALOG_ID } from "@/lib/manager";
import { managerProxy } from "@/lib/manager-proxy";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!DIALOG_ID.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  return managerProxy(request, `/api/sessions/${id}`);
}
