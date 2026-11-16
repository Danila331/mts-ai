import type { Metadata } from "next";
import { Suspense } from "react";
import { DialogsView } from "./dialogs-view";

export const metadata: Metadata = { title: "Диалоги — EnergyTool AI" };

export default function Page() {
  // DialogsView читает ?id= (ссылка из карточки заявки) — этому нужна граница Suspense.
  return (
    <Suspense>
      <DialogsView />
    </Suspense>
  );
}
