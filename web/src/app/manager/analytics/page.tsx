import type { Metadata } from "next";
import { AnalyticsView } from "./analytics-view";

export const metadata: Metadata = { title: "Аналитика — EnergyTool AI" };

export default function Page() {
  return <AnalyticsView />;
}
