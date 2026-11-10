import type { Metadata } from "next";
import { Suspense } from "react";
import { Playground } from "./playground";

export const metadata: Metadata = { title: "Чат и отладка — EnergyTool AI" };

export default function Page() {
  return (
    <Suspense fallback={<div className="h-dvh" />}>
      <Playground />
    </Suspense>
  );
}
