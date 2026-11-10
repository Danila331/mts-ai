import type { Metadata } from "next";
import { AppHeader } from "@/components/app-header";
import { Playground } from "./playground";

export const metadata: Metadata = { title: "Чат и отладка — EnergyTool AI" };

export default function Page() {
  return (
    <div className="flex h-dvh flex-col">
      <AppHeader />
      <Playground />
    </div>
  );
}
