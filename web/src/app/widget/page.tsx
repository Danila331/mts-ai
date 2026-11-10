import type { Metadata } from "next";
import { WidgetStudio } from "./widget-studio";

export const metadata: Metadata = { title: "Виджет для сайта — EnergyTool AI" };

export default function Page() {
  return <WidgetStudio standUrl={process.env.EB_STAND_URL ?? "http://localhost:4000"} />;
}
