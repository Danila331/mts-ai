import type { NextConfig } from "next";

// Tailwind подключён через PostCSS (postcss.config.mjs) — отдельное правило для *.css в Turbopack не нужно.
const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Значок dev-сервера справа: слева внизу — строка стенда в сайдбаре, он её перекрывал.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
