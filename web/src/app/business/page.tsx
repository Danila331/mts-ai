import type { Metadata } from "next";
import { BusinessView } from "./business-view";

export const metadata: Metadata = { title: "Бизнес-кейс — EnergyTool AI" };

export default function Page() {
  return <BusinessView />;
}
