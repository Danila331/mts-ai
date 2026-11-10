#!/usr/bin/env node
// Стенд «виджет на сайте МТС»: раздаёт сохранённую копию energytool.mts.ru с отдельного порта (другой origin —
// честная проверка встраивания) и подставляет в index.html тег виджета. Копия сайта в репозиторий не кладётся.
//
//   node scripts/stand.mjs --site <папка energytool.mts.ru> [--port 4000] [--widget http://localhost:3000]
//
// Экспорт для деплоя (например, на Vercel): та же страница с виджетом, но статикой в новую папку, плюс
// SPA-маршрутизация. С --protect стенд закрывается логином/паролем (Basic Auth, пароль — переменная
// STAND_PASSWORD в проекте Vercel; без неё стенд не открывается никому):
//
//   node scripts/stand.mjs --site <папка energytool.mts.ru> --widget https://<стенд> --export <новая папка> [--protect]
//
// Без зависимостей. Счётчики аналитики МТС (tag.a.mts.ru) из страницы вырезаются, чтобы стенд не слал события.

import { cpSync, createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const site = resolve(args.site ?? process.env.MTS_SITE_DIR ?? "");
const port = Number(args.port ?? process.env.STAND_PORT ?? 4000);
const widget = (args.widget ?? process.env.WIDGET_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");

if (!args.site && !process.env.MTS_SITE_DIR) {
  console.error("Укажите папку сайта: node scripts/stand.mjs --site <путь к energytool.mts.ru>");
  process.exit(1);
}
if (!existsSync(join(site, "index.html"))) {
  console.error(`В ${site} нет index.html — нужна папка energytool.mts.ru из архива сайта`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".map": "application/json",
};

/**
 * Тег виджета — один для локального стенда и для экспорта: web/public/stand.js с адреса стенда EnergyTool AI.
 * Он сам читает настройки превью из адреса (?w_title=…, ?w_preview=1) и подключает widget.js с умолчаниями
 * виджета. В копии сайта нет ничего от виджета, кроме этой строки, поэтому развёрнутый стенд не нужно
 * пересобирать: каждая выкладка EnergyTool AI сразу меняет виджет и на нём.
 */
const TAG = `<script src="${widget}/stand.js" async></script>`;

function page() {
  let html = readFileSync(join(site, "index.html"), "utf8");
  // Счётчик МТС (dataLayer / tag.a.mts.ru) — вырезаем инлайн-скрипт целиком.
  html = html.replace(/<script[^>]*>(?:(?!<\/script>)[\s\S])*tag\.a\.mts\.ru(?:(?!<\/script>)[\s\S])*<\/script>/g, "");
  return html.replace("</body>", `${TAG}</body>`);
}

// Только для --protect: пока STAND_PASSWORD не задан, стенд не открывается никому.
const MIDDLEWARE = `// Демо-стенд закрыт логином и паролем (Basic Auth). Пароль — переменная окружения STAND_PASSWORD
// в проекте Vercel, логин — STAND_USER (по умолчанию jury). Без пароля стенд не открывается никому.
export const config = { matcher: "/:path*" };

const text = (body, status, headers = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

export default function middleware(request) {
  const password = process.env.STAND_PASSWORD;
  const user = process.env.STAND_USER || "jury";
  if (!password) return text("Демо-стенд закрыт: в проекте не задан пароль (STAND_PASSWORD).", 503);
  const [scheme, encoded] = (request.headers.get("authorization") || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const raw = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
    const i = raw.indexOf(":");
    if (raw.slice(0, i) === user && raw.slice(i + 1) === password) {
      return new Response(null, { headers: { "x-middleware-next": "1" } });
    }
  }
  return text("Нужны логин и пароль демо-стенда.", 401, {
    "WWW-Authenticate": 'Basic realm="EnergyTool demo", charset="UTF-8"',
  });
}
`;

function exportStatic(out) {
  if (existsSync(out) && readdirSync(out).length) {
    console.error(`Папка ${out} не пуста — укажите новую`);
    process.exit(1);
  }
  cpSync(site, out, { recursive: true });
  writeFileSync(join(out, "index.html"), page());
  // SPA: файлы отдаются как есть, остальные пути — index.html (роутинг приложения разберётся сам).
  writeFileSync(
    join(out, "vercel.json"),
    `${JSON.stringify({ rewrites: [{ source: "/(.*)", destination: "/index.html" }] }, null, 2)}\n`,
  );
  if ("protect" in args) writeFileSync(join(out, "middleware.js"), MIDDLEWARE);
  console.log(
    `Стенд для деплоя: ${out} (виджет: ${widget}/widget.js${"protect" in args ? ", закрыт паролем" : ", открыт"})`,
  );
}

if (args.export) {
  exportStatic(resolve(args.export));
  process.exit(0);
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://stand");
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const file = join(site, rel);
  if (!file.startsWith(site + sep) && file !== site) {
    res.writeHead(403).end();
    return;
  }
  const isFile = existsSync(file) && statSync(file).isFile();
  if (!isFile || rel === "index.html") {
    // SPA: любые пути без файла — index.html с виджетом (роутинг приложения разберётся сам).
    if (extname(rel) && !isFile && rel !== "index.html") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
    res.end(page());
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`Сайт МТС EnergyTool с виджетом: http://localhost:${port}  (виджет: ${widget}/widget.js)`);
});
