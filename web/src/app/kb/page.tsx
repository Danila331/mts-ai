import type { Metadata } from "next";
import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { KbBrowser } from "./kb-browser";

export const metadata: Metadata = { title: "База знаний — EnergyTool AI" };

export default function Page() {
  return (
    <div className="flex h-dvh flex-col">
      <AppHeader />
      <Suspense fallback={<div className="flex-1" />}>
        <KbBrowser />
      </Suspense>
    </div>
  );
}
