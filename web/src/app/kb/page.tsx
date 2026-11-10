import type { Metadata } from "next";
import { Suspense } from "react";
import { KbBrowser } from "./kb-browser";

export const metadata: Metadata = { title: "База знаний — EnergyTool AI" };

export default function Page() {
  return (
    <Suspense fallback={<div className="h-dvh" />}>
      <KbBrowser />
    </Suspense>
  );
}
