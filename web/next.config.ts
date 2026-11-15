import type { NextConfig } from "next";

// Tailwind подключён через PostCSS (postcss.config.mjs) — отдельное правило для *.css в Turbopack не нужно.
const nextConfig: NextConfig = {
  // Сервер с минимальным набором зависимостей в .next/standalone — его запускает образ web/Dockerfile.
  // Vercel собирает фронт своим способом, ему настройка не мешает.
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  // Значок dev-сервера справа: слева внизу — строка стенда в сайдбаре, он её перекрывал.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
