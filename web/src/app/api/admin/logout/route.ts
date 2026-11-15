import { clearAdminCookie } from "@/lib/backend";

export async function POST(request: Request) {
  return Response.json({ admin: false }, { headers: { "Set-Cookie": clearAdminCookie(request) } });
}
