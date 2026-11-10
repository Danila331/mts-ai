import type { Metadata } from "next";
import { Suspense } from "react";
import { EmbedChat } from "./embed-chat";

export const metadata: Metadata = { title: "Консультант EnergyTool", robots: { index: false } };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <EmbedChat />
    </Suspense>
  );
}
