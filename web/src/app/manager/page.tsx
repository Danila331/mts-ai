import type { Metadata } from "next";
import { LeadsView } from "./leads-view";

export const metadata: Metadata = { title: "Заявки менеджера — EnergyTool AI" };

export default function Page() {
  return <LeadsView />;
}
