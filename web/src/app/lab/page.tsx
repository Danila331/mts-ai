import type { Metadata } from "next";
import { LabView } from "./lab-view";
import latest from "./personas-latest.json";
import { isReport } from "./report";

export const metadata: Metadata = { title: "Стресс-тест по персонам — EnergyTool AI" };

// Отчёт — часть сборки: последний закоммиченный прогон eval/personas.py, без запросов к API и к модели.
export default function Page() {
  const data: unknown = latest;
  return <LabView report={isReport(data) ? data : null} />;
}
