import type { Metadata } from "next";
import { AppHeader } from "@/components/app-header";
import { WidgetStudio } from "./widget-studio";

export const metadata: Metadata = { title: "Виджет для сайта — EnergyTool AI" };

export default function Page() {
  return (
    <div className="flex h-dvh flex-col">
      <AppHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WidgetStudio standUrl={process.env.EB_STAND_URL ?? "http://localhost:4000"} />
      </div>
    </div>
  );
}
