#!/usr/bin/env node
// Стенд «виджет на сайте МТС»: раздаёт сохранённую копию energytool.mts.ru с отдельного порта (другой origin —
// честная проверка встраивания) и подставляет в index.html тег виджета. Копия сайта в репозиторий не кладётся.
//
//   node scripts/stand.mjs --site <папка energytool.mts.ru> [--port 4000] [--widget http://localhost:3000]
//
// Без зависимостей. Счётчики аналитики МТС (tag.a.mts.ru) из страницы вырезаются, чтобы стенд не слал события.

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
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

const TAG = `<script src="${widget}/widget.js" async
  data-title="Консультант EnergyTool"
  data-color="#FF0032"
  data-position="right"
  data-greeting="Здравствуйте! Подскажу, как сократить расходы на электроэнергию и какой продукт EnergyTool вам подойдёт."
  data-greeting-delay="4"></script>`;

function page() {
  let html = readFileSync(join(site, "index.html"), "utf8");
  // Счётчик МТС (dataLayer / tag.a.mts.ru) — вырезаем инлайн-скрипт целиком.
  html = html.replace(/<script[^>]*>(?:(?!<\/script>)[\s\S])*tag\.a\.mts\.ru(?:(?!<\/script>)[\s\S])*<\/script>/g, "");
  return html.replace("</body>", `${TAG}</body>`);
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
