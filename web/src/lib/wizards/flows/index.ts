/**
 * Все мастера. Новый сценарий (T19, T20) — отдельный файл в этой папке и строка в {@link FLOWS}: общий тест
 * сверки с базой (`../wizards.test.ts`) пройдёт и по нему, движок при этом не меняется.
 */
import type { WizardFlow } from "../engine.ts";
import { BILL_GROWTH } from "./bill-growth.ts";
import { DIAGNOSTICS } from "./diagnostics.ts";
import { METERING_COMPLIANCE } from "./metering-compliance.ts";
import { PRICE_NAVIGATOR } from "./price-navigator.ts";

export { BILL_GROWTH, DIAGNOSTICS, METERING_COMPLIANCE, PRICE_NAVIGATOR };

export const FLOWS: readonly WizardFlow[] = [DIAGNOSTICS, BILL_GROWTH, PRICE_NAVIGATOR, METERING_COMPLIANCE];

export function flowById(id: string): WizardFlow | undefined {
  return FLOWS.find((f) => f.id === id);
}
