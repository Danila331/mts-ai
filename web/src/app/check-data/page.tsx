import type { Metadata } from "next";
import { CheckDataView } from "./check-data-view";

export const metadata: Metadata = { title: "Проверить выгрузку — EnergyTool AI" };

export default function Page() {
  return <CheckDataView />;
}
