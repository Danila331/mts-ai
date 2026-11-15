// Бюджет размера загрузчика виджета (T32): public/widget.js ≤ 8 КБ gzip. Запуск: npm run check:widget
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BUDGET = Number(process.env.WIDGET_BUDGET_BYTES ?? 8 * 1024);
const file = new URL("../public/widget.js", import.meta.url);
const raw = readFileSync(file);
const gz = gzipSync(raw, { level: 9 }).length;
console.log(`widget.js: ${raw.length} Б, gzip ${gz} Б (бюджет ${BUDGET} Б)`);
if (gz > BUDGET) {
  console.error("Превышен бюджет размера widget.js");
  process.exit(1);
}
