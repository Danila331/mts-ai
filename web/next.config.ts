import type { NextConfig } from "next";

// Tailwind подключён через PostCSS (postcss.config.mjs) — отдельное правило для *.css в Turbopack не нужно.
const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Значок dev-сервера перекрывал панель отладки и поле ввода на демо.
  devIndicators: false,
};

export default nextConfig;
