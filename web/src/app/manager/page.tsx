import type { Metadata } from "next";
import { Suspense } from "react";
import { LeadsView } from "./leads-view";

export const metadata: Metadata = { title: "Заявки менеджера — EnergyTool AI" };

export default function Page() {
  // LeadsView читает ?lead= (ссылка из диалога) — этому нужна граница Suspense.
  return (
    <Suspense>
      <LeadsView />
    </Suspense>
  );
}
