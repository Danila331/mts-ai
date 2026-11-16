import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Metadata } from "next";
import { formatKb } from "@/lib/site-preview";
import { WidgetStudio } from "./widget-studio";

export const metadata: Metadata = { title: "Виджет для сайта — EnergyTool AI" };

/** Реальный размер public/widget.js (gzip) — считается при сборке, а не хардкодом. */
function scriptSize(): string | null {
  try {
    return formatKb(gzipSync(readFileSync(join(process.cwd(), "public", "widget.js")), { level: 9 }).length);
  } catch {
    return null;
  }
}

export default function Page() {
  return <WidgetStudio standUrl={process.env.EB_STAND_URL ?? "http://localhost:4000"} scriptSize={scriptSize()} />;
}
