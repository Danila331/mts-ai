import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { parseOrigins } from "@/lib/embed-origin";
import { EmbedChat } from "./embed-chat";

export const metadata: Metadata = { title: "Консультант EnergyTool", robots: { index: false } };

/**
 * Allowlist хозяев читается при запросе, а не при сборке (connection() делает страницу динамической): тот же
 * список, что в заголовке frame-ancestors (src/proxy.ts), поэтому `?parent=` сверяется с ним же.
 */
async function Chat() {
  await connection();
  return <EmbedChat allowedOrigins={parseOrigins(process.env.EB_EMBED_ALLOWED_ORIGINS)} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Chat />
    </Suspense>
  );
}
