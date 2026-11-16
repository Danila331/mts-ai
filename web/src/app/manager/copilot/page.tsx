import type { Metadata } from "next";
import { Copilot } from "./copilot";

export const metadata: Metadata = { title: "Копилот менеджера — EnergyTool AI" };

export default function Page() {
  return <Copilot />;
}
