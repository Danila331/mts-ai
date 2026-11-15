import type { NextConfig } from "next";
import { STATIC_HEADERS } from "./src/lib/security-headers.ts";

// Tailwind подключён через PostCSS (postcss.config.mjs) — отдельное правило для *.css в Turbopack не нужно.
const nextConfig: NextConfig = {
  // Сервер с минимальным набором зависимостей в .next/standalone — его запускает образ web/Dockerfile.
  // Vercel собирает фронт своим способом, ему настройка не мешает.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  // Значок dev-сервера справа: слева внизу — строка стенда в сайдбаре, он её перекрывал.
  devIndicators: { position: "bottom-right" },
  // Постоянные заголовки безопасности (T35). headers() вычисляется при сборке, поэтому здесь только то, что не
  // зависит от окружения; frame-ancestors по EB_EMBED_ALLOWED_ORIGINS читается при запуске — src/proxy.ts.
  async headers() {
    return [{ source: "/:path*", headers: [...STATIC_HEADERS] }];
  },
};

export default nextConfig;
